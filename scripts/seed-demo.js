import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/security.js';
import { nowIso, uuid } from '../server/util.js';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoPass123!';
if (DEMO_PASSWORD.length < 8) {
  throw new Error('DEMO_PASSWORD 至少需要 8 个字符');
}

const DEMO_USERS = [
  { username: 'demo_manager', displayName: '林知远 · 项目经理' },
  { username: 'demo_reviewer', displayName: '沈禾 · 质检员' },
  { username: 'demo_annotator', displayName: '周野 · 标注员' },
];

class HttpClient {
  constructor(baseUrl, name) {
    this.baseUrl = baseUrl;
    this.name = name;
    this.cookie = '';
    this.user = null;
  }

  async request(method, apiPath, { json, raw, contentType } = {}) {
    const headers = { Accept: 'application/json' };
    if (this.cookie) headers.Cookie = this.cookie;
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (raw !== undefined) {
      headers['Content-Type'] = contentType || 'application/octet-stream';
      body = raw;
    }
    if (method !== 'GET' && method !== 'HEAD') headers['X-OM-Request'] = '1';

    const response = await fetch(this.baseUrl + apiPath, { method, headers, body });
    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const cookie of setCookies) {
      const match = /^om_session=([^;]*)/.exec(cookie);
      if (match) this.cookie = `om_session=${match[1]}`;
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const message = payload?.error?.message || text.slice(0, 300) || response.statusText;
      throw new Error(`${this.name} ${method} ${apiPath} -> HTTP ${response.status}：${message}`);
    }
    return payload;
  }

  async login(username, password) {
    const payload = await this.request('POST', '/api/auth/login', { json: { username, password } });
    this.user = payload.user;
    return payload.user;
  }
}

function ensureDemoUser(db, user, password) {
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(user.username);
  const passwordHash = hashPassword(password);
  if (existing) {
    db.prepare(
      "UPDATE users SET display_name = ?, password_hash = ?, status = 'active' WHERE id = ?"
    ).run(user.displayName, passwordHash, existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    return existing.id;
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, status, created_at)
     VALUES (?, ?, ?, ?, 'user', 'active', ?)`
  ).run(id, user.username, user.displayName, passwordHash, nowIso());
  return id;
}

/* ---------- PNG fixture generation ---------- */

let crcTable = null;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function mixColor(a, b, t) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * t));
}

function shadeColor(color, factor) {
  return color.map((value) => Math.max(0, Math.min(255, Math.round(value * factor))));
}

class Raster {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 3);
  }

  set(x, y, color) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 3;
    this.pixels[index] = color[0];
    this.pixels[index + 1] = color[1];
    this.pixels[index + 2] = color[2];
  }

  rect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) this.set(xx, yy, color);
    }
  }

  gradient(x, y, w, h, top, bottom) {
    const y0 = Math.max(0, Math.floor(y));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) {
      const t = h <= 1 ? 0 : (yy - y) / h;
      this.rect(x, yy, w, 1, mixColor(top, bottom, Math.max(0, Math.min(1, t))));
    }
  }

  circle(cx, cy, radius, color) {
    const x0 = Math.floor(cx - radius);
    const x1 = Math.ceil(cx + radius);
    const y0 = Math.floor(cy - radius);
    const y1 = Math.ceil(cy + radius);
    const r2 = radius * radius;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) this.set(x, y, color);
      }
    }
  }
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IMAGE_W = 960;
const IMAGE_H = 600;

function paintBackdrop(raster, seed) {
  const rng = makeRng(seed);
  raster.gradient(0, 0, IMAGE_W, 360, [48, 78, 112], [160, 188, 204]);
  raster.circle(790, 104, 42, [238, 208, 152]);
  raster.circle(790, 104, 58, [214, 192, 156]);

  let x = -30;
  while (x < IMAGE_W) {
    const width = 62 + Math.floor(rng() * 92);
    const height = 88 + Math.floor(rng() * 152);
    const base = 360;
    const color = mixColor([74, 92, 112], [124, 138, 150], rng());
    raster.rect(x, base - height, width, height, color);
    for (let wy = base - height + 14; wy < base - 18; wy += 24) {
      for (let wx = x + 10; wx < x + width - 12; wx += 22) {
        if (rng() > 0.52) raster.rect(wx, wy, 8, 11, [224, 208, 154]);
      }
    }
    x += width + 8 + Math.floor(rng() * 18);
  }

  raster.rect(0, 360, IMAGE_W, 50, [134, 136, 138]);
  raster.rect(0, 406, IMAGE_W, 8, [186, 186, 182]);
  raster.rect(0, 414, IMAGE_W, 186, [62, 66, 72]);
  for (let dx = 18; dx < IMAGE_W; dx += 132) {
    raster.rect(dx, 504, 72, 8, [214, 210, 196]);
  }
  for (let i = 0; i < 900; i++) {
    raster.rect(6 + rng() * (IMAGE_W - 12), 418 + rng() * 176, 2, 2, [80, 84, 90]);
  }
}

function drawShadow(raster, rect) {
  raster.rect(rect.x + 10, rect.y + rect.h - 8, rect.w - 20, 12, [44, 47, 52]);
}

function drawCar(raster, rect, color) {
  const { x, y, w, h } = rect;
  drawShadow(raster, rect);
  raster.rect(x, y + h * 0.32, w, h * 0.6, color);
  raster.rect(x + w * 0.2, y + h * 0.08, w * 0.58, h * 0.34, shadeColor(color, 1.12));
  raster.rect(x + w * 0.24, y + h * 0.12, w * 0.21, h * 0.2, [36, 54, 70]);
  raster.rect(x + w * 0.5, y + h * 0.12, w * 0.21, h * 0.2, [36, 54, 70]);
  raster.rect(x + w * 0.9, y + h * 0.46, w * 0.07, h * 0.08, [248, 226, 152]);
  const wheel = Math.round(h * 0.14);
  raster.circle(x + w * 0.2, y + h * 0.92, wheel, [28, 30, 34]);
  raster.circle(x + w * 0.8, y + h * 0.92, wheel, [28, 30, 34]);
  raster.circle(x + w * 0.2, y + h * 0.92, Math.round(wheel * 0.45), [156, 156, 158]);
  raster.circle(x + w * 0.8, y + h * 0.92, Math.round(wheel * 0.45), [156, 156, 158]);
}

function drawBus(raster, rect) {
  const { x, y, w, h } = rect;
  const body = [42, 132, 128];
  drawShadow(raster, rect);
  raster.rect(x, y + h * 0.06, w, h * 0.8, body);
  raster.rect(x + w * 0.02, y + h * 0.1, w * 0.96, h * 0.2, shadeColor(body, 1.25));
  for (let i = 0; i < 6; i++) {
    raster.rect(x + w * (0.06 + i * 0.14), y + h * 0.16, w * 0.1, h * 0.22, [38, 58, 72]);
  }
  raster.rect(x + w * 0.72, y + h * 0.44, w * 0.16, h * 0.36, [30, 48, 58]);
  raster.rect(x + w * 0.06, y + h * 0.46, w * 0.5, h * 0.03, [224, 214, 184]);
  raster.rect(x + w * 0.86, y + h * 0.52, w * 0.06, h * 0.12, [248, 226, 152]);
  const wheel = Math.round(h * 0.13);
  raster.circle(x + w * 0.2, y + h * 0.9, wheel, [28, 30, 34]);
  raster.circle(x + w * 0.78, y + h * 0.9, wheel, [28, 30, 34]);
  raster.circle(x + w * 0.2, y + h * 0.9, Math.round(wheel * 0.4), [156, 156, 158]);
  raster.circle(x + w * 0.78, y + h * 0.9, Math.round(wheel * 0.4), [156, 156, 158]);
}

function drawPerson(raster, rect) {
  const { x, y, w, h } = rect;
  const cx = x + w / 2;
  raster.circle(cx, y + h * 0.12, w * 0.34, [226, 190, 162]);
  raster.rect(cx - w * 0.3, y + h * 0.23, w * 0.6, h * 0.36, [68, 112, 168]);
  raster.rect(cx - w * 0.26, y + h * 0.59, w * 0.2, h * 0.38, [40, 44, 52]);
  raster.rect(cx + w * 0.06, y + h * 0.59, w * 0.2, h * 0.38, [40, 44, 52]);
  raster.rect(cx - w * 0.42, y + h * 0.28, w * 0.12, h * 0.3, [68, 112, 168]);
  raster.rect(cx + w * 0.3, y + h * 0.28, w * 0.12, h * 0.3, [68, 112, 168]);
}

function drawTrafficLight(raster, rect) {
  const { x, y, w, h } = rect;
  raster.rect(x + w * 0.42, y + h * 0.3, w * 0.16, h * 0.7, [44, 48, 54]);
  raster.rect(x, y, w, h * 0.38, [32, 36, 42]);
  raster.circle(x + w / 2, y + h * 0.08, w * 0.24, [236, 88, 82]);
  raster.circle(x + w / 2, y + h * 0.18, w * 0.24, [120, 98, 48]);
  raster.circle(x + w / 2, y + h * 0.28, w * 0.24, [54, 104, 78]);
}

function boxAnnotation(id, label, rect, pad = 8) {
  return {
    id,
    type: 'box',
    label,
    x: Math.round(rect.x - pad),
    y: Math.round(rect.y - pad),
    w: Math.round(rect.w + pad * 2),
    h: Math.round(rect.h + pad * 2),
  };
}

function buildImageScene(scene) {
  const raster = new Raster(IMAGE_W, IMAGE_H);
  paintBackdrop(raster, scene.seed);
  for (const object of scene.objects) {
    if (object.kind === 'car') drawCar(raster, object.rect, object.color);
    else if (object.kind === 'bus') drawBus(raster, object.rect);
    else if (object.kind === 'person') drawPerson(raster, object.rect);
    else if (object.kind === 'light') drawTrafficLight(raster, object.rect);
  }
  return { buffer: encodePng(IMAGE_W, IMAGE_H, raster.pixels), shapes: scene.shapes };
}

const carRed = [190, 64, 58];
const carBlue = [58, 108, 182];
const carGraphite = [74, 82, 94];

const sceneRedCar = {
  seed: 17,
  objects: [
    { kind: 'car', rect: { x: 120, y: 405, w: 230, h: 105 }, color: carRed },
    { kind: 'car', rect: { x: 590, y: 375, w: 210, h: 96 }, color: carBlue },
    { kind: 'person', rect: { x: 455, y: 300, w: 46, h: 130 } },
    { kind: 'light', rect: { x: 846, y: 200, w: 52, h: 170 } },
  ],
  shapes: [
    boxAnnotation('img1-car-red', 'car', { x: 120, y: 405, w: 230, h: 105 }),
    boxAnnotation('img1-car-blue', 'car', { x: 590, y: 375, w: 210, h: 96 }),
    boxAnnotation('img1-person', 'person', { x: 455, y: 300, w: 46, h: 130 }),
    boxAnnotation('img1-light', 'traffic_light', { x: 846, y: 200, w: 52, h: 170 }),
  ],
};

const sceneBusStop = {
  seed: 29,
  objects: [
    { kind: 'bus', rect: { x: 300, y: 355, w: 300, h: 150 } },
    { kind: 'person', rect: { x: 145, y: 325, w: 48, h: 128 } },
    { kind: 'person', rect: { x: 730, y: 335, w: 50, h: 135 } },
  ],
  shapes: [
    {
      id: 'img2-bus',
      type: 'polygon',
      label: 'bus',
      points: [
        { x: 294, y: 347 },
        { x: 606, y: 347 },
        { x: 616, y: 512 },
        { x: 286, y: 512 },
      ],
    },
    boxAnnotation('img2-person-left', 'person', { x: 145, y: 325, w: 48, h: 128 }),
    boxAnnotation('img2-person-right', 'person', { x: 730, y: 335, w: 50, h: 135 }),
  ],
};

const sceneEveningWalk = {
  seed: 43,
  objects: [
    { kind: 'car', rect: { x: 500, y: 405, w: 230, h: 105 }, color: carGraphite },
    { kind: 'person', rect: { x: 210, y: 315, w: 48, h: 130 } },
    { kind: 'light', rect: { x: 80, y: 205, w: 50, h: 165 } },
  ],
  shapes: [
    boxAnnotation('img3-car', 'car', { x: 500, y: 405, w: 230, h: 105 }),
  ],
};

const sceneMarketCorner = {
  seed: 61,
  objects: [
    { kind: 'bus', rect: { x: 160, y: 360, w: 290, h: 145 } },
    { kind: 'car', rect: { x: 640, y: 415, w: 210, h: 95 }, color: carRed },
    { kind: 'person', rect: { x: 470, y: 330, w: 46, h: 125 } },
  ],
  shapes: [],
};

/* ---------- text fixtures ---------- */

function parseMarkedText(template) {
  const pattern = /\[\[([^\]|]+)\|([a-z0-9_-]+)\]\]/g;
  let text = '';
  let cursor = 0;
  let match;
  const entities = [];
  while ((match = pattern.exec(template))) {
    text += template.slice(cursor, match.index);
    const start = text.length;
    text += match[1];
    entities.push({
      id: `ent-${entities.length + 1}`,
      start,
      end: text.length,
      label: match[2],
    });
    cursor = pattern.lastIndex;
  }
  text += template.slice(cursor);
  return { text, entities };
}

const textDocuments = [
  {
    filename: 'edge_platform_launch.txt',
    template:
      '2026年10月18日，[[星河科技|org]]在[[北京|location]]发布新一代边缘计算平台「[[烛龙|product]]」。公司首席执行官[[李明|person]]表示，平台将服务智能制造与城市交通。发布会当天，[[清华大学|org]]和[[北京大学|org]]的联合团队展示了合作项目。',
    documentLabels: ['positive'],
  },
  {
    filename: 'data_circulation_guideline.txt',
    template:
      '[[国家数据局|org]]今日发布《数据要素流通指引》。[[周敏|person]]在[[上海|location]]举行的说明会上指出，新规将降低中小企业的数据使用成本。[[云图数据|org]]与[[复旦大学|org]]参与了试点。',
    documentLabels: ['neutral'],
  },
  {
    filename: 'bank_risk_center.txt',
    template:
      '[[海川银行|org]]计划在[[深圳|location]]建设智能风控中心，核心系统采用自研的「[[天枢|product]]」平台。项目负责人[[陈立|person]]透露，中心预计于2027年投入使用，首批将招聘300名工程师。',
    documentLabels: ['positive'],
  },
  {
    filename: 'yangtze_region_meeting.txt',
    template:
      '[[长三角|location]]区域协作会议在[[杭州|location]]召开，[[林可|person]]代表[[启明研究院|org]]出席。会议讨论了跨区域数据共享与算力调度。',
    documentLabels: ['neutral'],
  },
];

/* ---------- audio fixtures ---------- */

function round2(value) {
  return Math.round(value * 100) / 100;
}

function audioSegments(seconds) {
  return [
    { start: round2(seconds * 0.12), end: round2(seconds * 0.48), label: 'speech' },
    { start: round2(seconds * 0.48), end: round2(seconds * 0.72), label: 'music' },
    { start: round2(seconds * 0.72), end: round2(seconds * 0.9), label: 'noise' },
  ];
}

function encodeWav(seconds, variant) {
  const sampleRate = 22050;
  const total = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(total * 2);
  const rng = makeRng(3407 + variant * 97);
  const segments = audioSegments(seconds);
  const [speech, music, noise] = segments;
  const notes = [261.63, 293.66, 329.63, 392.0, 440.0];

  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    let sample = 0;
    if (t >= speech.start && t < speech.end) {
      const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.6 * t + variant * 0.7) ** 2;
      const f0 = 150 + 18 * Math.sin(2 * Math.PI * 2.2 * t + variant);
      sample =
        0.22 *
          syllable *
          (Math.sin(2 * Math.PI * f0 * t) +
            0.5 * Math.sin(4 * Math.PI * f0 * t) +
            0.25 * Math.sin(6 * Math.PI * f0 * t)) +
        0.012 * (rng() * 2 - 1);
    } else if (t >= music.start && t < music.end) {
      const local = t - music.start;
      const frequency = notes[(Math.floor(local * 3 + variant) + notes.length) % notes.length];
      const envelope = Math.sin(Math.PI * (local / (music.end - music.start))) ** 0.6;
      sample =
        0.16 *
        envelope *
        (Math.sin(2 * Math.PI * frequency * t) + 0.4 * Math.sin(4 * Math.PI * frequency * t));
    } else if (t >= noise.start && t < noise.end) {
      const relative = (t - noise.start) / (noise.end - noise.start);
      sample = 0.3 * Math.sin(Math.PI * relative) * (rng() * 2 - 1);
    } else {
      sample = 0.004 * (rng() * 2 - 1);
    }
    const value = Math.max(-1, Math.min(1, sample));
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/* ---------- spatial fixtures ---------- */

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function polygonGeometry(points) {
  const ring = points.map(([lon, lat]) => [round6(lon), round6(lat)]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  return { type: 'Polygon', coordinates: [ring] };
}

function lineGeometry(points) {
  return {
    type: 'LineString',
    coordinates: points.map(([lon, lat]) => [round6(lon), round6(lat)]),
  };
}

function pointGeometry(lon, lat) {
  return { type: 'Point', coordinates: [round6(lon), round6(lat)] };
}

function spatialFeature(name, geometry, extra = {}) {
  return { type: 'Feature', properties: { name, ...extra }, geometry };
}

function buildGeoJson(name, features) {
  return Buffer.from(JSON.stringify({ type: 'FeatureCollection', name, features }, null, 2), 'utf8');
}

const xichengBuildings = [
  spatialFeature(
    '西单商厦',
    polygonGeometry([
      [116.368, 39.912],
      [116.373, 39.912],
      [116.373, 39.917],
      [116.368, 39.917],
    ])
  ),
  spatialFeature(
    '金融街中心',
    polygonGeometry([
      [116.375, 39.911],
      [116.38, 39.911],
      [116.38, 39.915],
      [116.375, 39.915],
    ])
  ),
  spatialFeature(
    '月坛公寓',
    polygonGeometry([
      [116.373, 39.919],
      [116.378, 39.919],
      [116.378, 39.923],
      [116.373, 39.923],
    ])
  ),
];
const xichengRoads = [
  spatialFeature(
    '西长安街',
    lineGeometry([
      [116.362, 39.909],
      [116.372, 39.909],
      [116.386, 39.909],
    ])
  ),
  spatialFeature(
    '太平桥大街',
    lineGeometry([
      [116.374, 39.904],
      [116.374, 39.916],
      [116.374, 39.928],
    ])
  ),
];
const xichengWater = spatialFeature(
  '什刹海水域',
  polygonGeometry([
    [116.381, 39.918],
    [116.384, 39.918],
    [116.384, 39.921],
    [116.381, 39.921],
  ])
);
const xichengPark = spatialFeature(
  '月坛公园',
  polygonGeometry([
    [116.366, 39.918],
    [116.37, 39.918],
    [116.37, 39.922],
    [116.366, 39.922],
  ])
);

const chaoyangBuildings = [
  spatialFeature(
    '国贸大厦',
    polygonGeometry([
      [116.454, 39.905],
      [116.461, 39.905],
      [116.461, 39.912],
      [116.454, 39.912],
    ])
  ),
  spatialFeature(
    '央视总部',
    polygonGeometry([
      [116.463, 39.913],
      [116.468, 39.913],
      [116.468, 39.918],
      [116.463, 39.918],
    ])
  ),
];
const chaoyangRoads = [
  spatialFeature(
    '建国路',
    lineGeometry([
      [116.44, 39.908],
      [116.455, 39.908],
      [116.47, 39.908],
      [116.49, 39.908],
    ])
  ),
  spatialFeature(
    '东三环',
    lineGeometry([
      [116.461, 39.895],
      [116.461, 39.912],
      [116.461, 39.93],
    ])
  ),
];
const chaoyangPark = spatialFeature(
  '朝阳公园',
  polygonGeometry([
    [116.47, 39.93],
    [116.485, 39.93],
    [116.485, 39.94],
    [116.47, 39.94],
  ])
);

const aosenParkFeature = spatialFeature(
  '奥林匹克森林公园',
  polygonGeometry([
    [116.383, 40.005],
    [116.405, 40.005],
    [116.405, 40.028],
    [116.383, 40.028],
  ])
);
const aosenWater = spatialFeature(
  '奥海湖面',
  polygonGeometry([
    [116.392, 40.012],
    [116.399, 40.012],
    [116.399, 40.018],
    [116.392, 40.018],
  ])
);
const aosenPaths = [
  spatialFeature(
    '环湖步道',
    lineGeometry([
      [116.39, 40.009],
      [116.4, 40.009],
      [116.402, 40.02],
      [116.394, 40.024],
    ])
  ),
];
const aosenBuilding = spatialFeature(
  '森林公园游客中心',
  polygonGeometry([
    [116.387, 40.02],
    [116.39, 40.02],
    [116.39, 40.022],
    [116.387, 40.022],
  ])
);

const zhongguancunFeatures = [
  spatialFeature(
    '中关村广场',
    polygonGeometry([
      [116.312, 39.981],
      [116.319, 39.981],
      [116.319, 39.986],
      [116.312, 39.986],
    ])
  ),
  spatialFeature(
    '海淀图书城',
    polygonGeometry([
      [116.321, 39.983],
      [116.326, 39.983],
      [116.326, 39.987],
      [116.321, 39.987],
    ])
  ),
  spatialFeature('中关村地铁站', pointGeometry(116.316, 39.984)),
  spatialFeature('海淀黄庄地铁站', pointGeometry(116.324, 39.982)),
];

function annotationFeature(id, label, feature) {
  return { id, label, geometry: JSON.parse(JSON.stringify(feature.geometry)) };
}

/* ---------- HTTP helpers ---------- */

async function uploadItem(ctx, project, { filename, data, contentType, assign = true }) {
  const payload = await ctx.manager.request(
    'POST',
    `/api/projects/${project.id}/items?filename=${encodeURIComponent(filename)}`,
    { raw: data, contentType }
  );
  const item = payload.item;
  if (assign) {
    await ctx.manager.request('PATCH', `/api/items/${item.id}`, {
      json: { assigneeId: ctx.annotator.user.id },
    });
  }
  return item;
}

async function submitAnnotation(client, itemId, data) {
  return client.request('PUT', `/api/items/${itemId}/annotation`, {
    json: { data, submit: true },
  });
}

async function saveDraft(client, itemId, data) {
  return client.request('PUT', `/api/items/${itemId}/annotation`, {
    json: { data, submit: false },
  });
}

async function reviewItem(client, itemId, decision, note) {
  return client.request('POST', `/api/items/${itemId}/review`, {
    json: { decision, note },
  });
}

async function patchDuration(ctx, itemId, duration) {
  await ctx.manager.request('PATCH', `/api/items/${itemId}`, {
    json: { meta: { duration } },
  });
}

const IMAGE_SCHEMA = {
  labels: [
    { id: 'car', name: '轿车', color: '#f5a524', hotkey: '1' },
    { id: 'bus', name: '公交车', color: '#4cc9f0', hotkey: '2' },
    { id: 'person', name: '行人', color: '#48c78e', hotkey: '3' },
    { id: 'traffic_light', name: '信号灯', color: '#ef5b5b', hotkey: '4' },
  ],
  documentLabels: [],
};

const TEXT_SCHEMA = {
  labels: [
    { id: 'person', name: '人物', color: '#f5a524', hotkey: '1' },
    { id: 'org', name: '机构', color: '#4cc9f0', hotkey: '2' },
    { id: 'location', name: '地点', color: '#48c78e', hotkey: '3' },
    { id: 'product', name: '产品', color: '#c084fc', hotkey: '4' },
  ],
  documentLabels: [
    { id: 'positive', name: '正向', color: '#48c78e', hotkey: 'a' },
    { id: 'neutral', name: '中立', color: '#8892a6', hotkey: 'b' },
    { id: 'negative', name: '负向', color: '#ef5b5b', hotkey: 'c' },
  ],
};

const AUDIO_SCHEMA = {
  labels: [
    { id: 'speech', name: '语音', color: '#f5a524', hotkey: '1' },
    { id: 'music', name: '音乐', color: '#c084fc', hotkey: '2' },
    { id: 'noise', name: '噪声', color: '#ef5b5b', hotkey: '3' },
  ],
  documentLabels: [],
};

const SPATIAL_SCHEMA = {
  labels: [
    { id: 'building', name: '建筑', color: '#f5a524', hotkey: '1' },
    { id: 'road', name: '道路', color: '#4cc9f0', hotkey: '2' },
    { id: 'water', name: '水体', color: '#48c78e', hotkey: '3' },
    { id: 'park', name: '绿地', color: '#c084fc', hotkey: '4' },
  ],
  documentLabels: [],
};

async function ensureProject(ctx, spec) {
  const list = await ctx.manager.request('GET', '/api/projects');
  const existing = list.projects.find((project) => project.name === spec.name);
  if (existing) {
    console.log(`· 项目「${spec.name}」已存在，跳过`);
    return null;
  }
  const created = await ctx.manager.request('POST', '/api/projects', {
    json: {
      name: spec.name,
      kind: spec.kind,
      description: spec.description,
      labelSchema: spec.labelSchema,
    },
  });
  const project = created.project;
  await ctx.manager.request('POST', `/api/projects/${project.id}/members`, {
    json: { userId: ctx.reviewer.user.id, role: 'reviewer' },
  });
  await ctx.manager.request('POST', `/api/projects/${project.id}/members`, {
    json: { userId: ctx.annotator.user.id, role: 'annotator' },
  });
  console.log(`· 创建项目「${spec.name}」（${spec.kind}）`);
  return project;
}

async function withProjectCleanup(ctx, project, fn) {
  try {
    await fn();
  } catch (error) {
    try {
      await ctx.manager.request('DELETE', `/api/projects/${project.id}`, {
        json: { confirmName: project.name },
      });
      console.log(`  已回滚不完整的项目「${project.name}」`);
    } catch (cleanupError) {
      console.error(`  回滚项目失败：${cleanupError.message}`);
    }
    throw error;
  }
}

async function seedImageProject(ctx) {
  const project = await ensureProject(ctx, {
    name: '街景目标检测',
    kind: 'image',
    description:
      '城市道路摄像头的目标检测样本：轿车、公交车、行人与信号灯。包含矩形框与多边形两种图元，以及完整的复核记录。',
    labelSchema: IMAGE_SCHEMA,
  });
  if (!project) return;
  await withProjectCleanup(ctx, project, async () => {
    const sceneA = buildImageScene(sceneRedCar);
    const itemA = await uploadItem(ctx, project, {
      filename: 'street_crossing_red_car.png',
      data: sceneA.buffer,
      contentType: 'image/png',
    });
    await submitAnnotation(ctx.annotator, itemA.id, {
      shapes: sceneA.shapes.filter((shape) => shape.label === 'car'),
      note: '先标两辆车。',
    });
    await reviewItem(
      ctx.reviewer,
      itemA.id,
      'reject',
      '漏标了画面中部的行人和右侧信号灯，请补齐后重新提交。'
    );
    await submitAnnotation(ctx.annotator, itemA.id, {
      shapes: sceneA.shapes,
      note: '已补齐行人与信号灯。',
    });
    await reviewItem(ctx.reviewer, itemA.id, 'approve', '四类目标齐全，边界贴合，通过。');

    const sceneB = buildImageScene(sceneBusStop);
    const itemB = await uploadItem(ctx, project, {
      filename: 'street_bus_stop.png',
      data: sceneB.buffer,
      contentType: 'image/png',
    });
    await submitAnnotation(ctx.annotator, itemB.id, {
      shapes: sceneB.shapes,
      note: '公交车使用多边形贴合车身。',
    });

    const sceneC = buildImageScene(sceneEveningWalk);
    const itemC = await uploadItem(ctx, project, {
      filename: 'street_evening_walk.png',
      data: sceneC.buffer,
      contentType: 'image/png',
    });
    await saveDraft(ctx.annotator, itemC.id, {
      shapes: sceneC.shapes,
      note: '待补充行人和信号灯。',
    });

    const sceneD = buildImageScene(sceneMarketCorner);
    await uploadItem(ctx, project, {
      filename: 'street_market_corner.png',
      data: sceneD.buffer,
      contentType: 'image/png',
      assign: false,
    });
  });
}

async function seedTextProject(ctx) {
  const project = await ensureProject(ctx, {
    name: '科技资讯实体抽取',
    kind: 'text',
    description:
      '科技与财经新闻的命名实体抽取：人物、机构、地点、产品，并附带文档级情感标签。包含一次完整的驳回与重提。',
    labelSchema: TEXT_SCHEMA,
  });
  if (!project) return;
  await withProjectCleanup(ctx, project, async () => {
    const first = parseMarkedText(textDocuments[0].template);
    const itemOne = await uploadItem(ctx, project, {
      filename: textDocuments[0].filename,
      data: Buffer.from(first.text, 'utf8'),
      contentType: 'text/plain; charset=utf-8',
    });
    await submitAnnotation(ctx.annotator, itemOne.id, {
      entities: first.entities.filter((entity) => entity.label !== 'org'),
      documentLabels: [],
      note: '机构实体待确认。',
    });
    await reviewItem(
      ctx.reviewer,
      itemOne.id,
      'reject',
      '机构实体漏标（星河科技、清华大学、北京大学），并请补充文档情感标签。'
    );
    await submitAnnotation(ctx.annotator, itemOne.id, {
      entities: first.entities,
      documentLabels: textDocuments[0].documentLabels,
      note: '已补全三个机构实体，并标注为正向。',
    });
    await reviewItem(ctx.reviewer, itemOne.id, 'approve', '实体区间准确，文档标签正确。');

    const second = parseMarkedText(textDocuments[1].template);
    const itemTwo = await uploadItem(ctx, project, {
      filename: textDocuments[1].filename,
      data: Buffer.from(second.text, 'utf8'),
      contentType: 'text/plain; charset=utf-8',
    });
    await submitAnnotation(ctx.annotator, itemTwo.id, {
      entities: second.entities,
      documentLabels: textDocuments[1].documentLabels,
      note: '',
    });

    const third = parseMarkedText(textDocuments[2].template);
    const itemThree = await uploadItem(ctx, project, {
      filename: textDocuments[2].filename,
      data: Buffer.from(third.text, 'utf8'),
      contentType: 'text/plain; charset=utf-8',
    });
    await submitAnnotation(ctx.annotator, itemThree.id, {
      entities: third.entities.filter((entity) => entity.label !== 'product'),
      documentLabels: ['positive'],
      note: '',
    });
    await reviewItem(
      ctx.reviewer,
      itemThree.id,
      'reject',
      '「天枢」产品实体漏标；情感标签请改为 neutral 后重新提交。'
    );

    const fourth = parseMarkedText(textDocuments[3].template);
    await uploadItem(ctx, project, {
      filename: textDocuments[3].filename,
      data: Buffer.from(fourth.text, 'utf8'),
      contentType: 'text/plain; charset=utf-8',
      assign: false,
    });
  });
}

async function seedAudioProject(ctx) {
  const project = await ensureProject(ctx, {
    name: '城市声音片段切分',
    kind: 'audio',
    description:
      '街头、地铁与公园的环境录音，按语音、音乐、噪声切分时间区段。包含时长元数据、驳回重提与待复核样本。',
    labelSchema: AUDIO_SCHEMA,
  });
  if (!project) return;
  await withProjectCleanup(ctx, project, async () => {
    const firstSeconds = 6;
    const itemOne = await uploadItem(ctx, project, {
      filename: 'market_street_6s.wav',
      data: encodeWav(firstSeconds, 1),
      contentType: 'audio/wav',
    });
    await patchDuration(ctx, itemOne.id, firstSeconds);
    const firstSegments = audioSegments(firstSeconds);
    await submitAnnotation(ctx.annotator, itemOne.id, {
      segments: firstSegments.filter((segment) => segment.label !== 'noise'),
      note: '噪声段待确认。',
    });
    await reviewItem(
      ctx.reviewer,
      itemOne.id,
      'reject',
      '4.3 秒之后有一段明显噪声未切分，请补全区段后重新提交。'
    );
    await submitAnnotation(ctx.annotator, itemOne.id, {
      segments: firstSegments,
      note: '已补全噪声区段。',
    });
    await reviewItem(ctx.reviewer, itemOne.id, 'approve', '三段边界清晰，通过。');

    const secondSeconds = 7.2;
    const itemTwo = await uploadItem(ctx, project, {
      filename: 'metro_platform_7s.wav',
      data: encodeWav(secondSeconds, 2),
      contentType: 'audio/wav',
    });
    await patchDuration(ctx, itemTwo.id, secondSeconds);
    await submitAnnotation(ctx.annotator, itemTwo.id, {
      segments: audioSegments(secondSeconds),
      note: '',
    });

    const thirdSeconds = 5.4;
    const itemThree = await uploadItem(ctx, project, {
      filename: 'park_walk_5s.wav',
      data: encodeWav(thirdSeconds, 3),
      contentType: 'audio/wav',
    });
    await patchDuration(ctx, itemThree.id, thirdSeconds);
    await saveDraft(ctx.annotator, itemThree.id, {
      segments: audioSegments(thirdSeconds).slice(0, 2),
      note: '音乐之后的噪声段尚未切分。',
    });

    const fourthSeconds = 8;
    const itemFour = await uploadItem(ctx, project, {
      filename: 'rain_crossing_8s.wav',
      data: encodeWav(fourthSeconds, 4),
      contentType: 'audio/wav',
      assign: false,
    });
    await patchDuration(ctx, itemFour.id, fourthSeconds);
  });
}

async function seedSpatialProject(ctx) {
  const project = await ensureProject(ctx, {
    name: '北京城区空间要素',
    kind: 'spatial',
    description:
      '北京城区 GeoJSON 底图，标注建筑、道路、水体与绿地。包含 EPSG:4326 坐标、面/线要素以及一次驳回记录。',
    labelSchema: SPATIAL_SCHEMA,
  });
  if (!project) return;
  await withProjectCleanup(ctx, project, async () => {
    const xichengFeatures = [
      ...xichengBuildings,
      ...xichengRoads,
      xichengWater,
      xichengPark,
    ];
    const xichengAnnotations = [
      ...xichengBuildings.map((feature, index) =>
        annotationFeature(`sp1-building-${index + 1}`, 'building', feature)
      ),
      ...xichengRoads.map((feature, index) =>
        annotationFeature(`sp1-road-${index + 1}`, 'road', feature)
      ),
      annotationFeature('sp1-water', 'water', xichengWater),
    ];
    const itemOne = await uploadItem(ctx, project, {
      filename: 'xicheng_blocks.geojson',
      data: buildGeoJson('西城街区底图', xichengFeatures),
      contentType: 'application/geo+json',
    });
    await submitAnnotation(ctx.annotator, itemOne.id, {
      features: xichengAnnotations.filter((feature) => feature.label === 'building'),
      note: '先标建筑。',
    });
    await reviewItem(
      ctx.reviewer,
      itemOne.id,
      'reject',
      '道路与水系要素尚未标注，请补充后重新提交。'
    );
    await submitAnnotation(ctx.annotator, itemOne.id, {
      features: xichengAnnotations,
      note: '已补齐道路与什刹海水域。',
    });
    await reviewItem(ctx.reviewer, itemOne.id, 'approve', '面线要素完整，坐标闭合正确。');

    const chaoyangFeatures = [
      ...chaoyangBuildings,
      ...chaoyangRoads,
      chaoyangPark,
    ];
    const chaoyangAnnotations = [
      ...chaoyangBuildings.map((feature, index) =>
        annotationFeature(`sp2-building-${index + 1}`, 'building', feature)
      ),
      ...chaoyangRoads.map((feature, index) =>
        annotationFeature(`sp2-road-${index + 1}`, 'road', feature)
      ),
      annotationFeature('sp2-park', 'park', chaoyangPark),
    ];
    const itemTwo = await uploadItem(ctx, project, {
      filename: 'guomao_network.geojson',
      data: buildGeoJson('国贸路网底图', chaoyangFeatures),
      contentType: 'application/geo+json',
    });
    await submitAnnotation(ctx.annotator, itemTwo.id, {
      features: chaoyangAnnotations,
      note: '',
    });

    const aosenFeatures = [
      aosenParkFeature,
      aosenWater,
      ...aosenPaths,
      aosenBuilding,
    ];
    const itemThree = await uploadItem(ctx, project, {
      filename: 'aosen_park.geojson',
      data: buildGeoJson('奥森公园底图', aosenFeatures),
      contentType: 'application/geo+json',
    });
    await submitAnnotation(ctx.annotator, itemThree.id, {
      features: [annotationFeature('sp3-park', 'park', aosenParkFeature)],
      note: '',
    });
    await reviewItem(
      ctx.reviewer,
      itemThree.id,
      'reject',
      '缺少奥海湖面与环湖步道，请补充水体、道路要素后再提交。'
    );

    await uploadItem(ctx, project, {
      filename: 'zhongguancun_places.geojson',
      data: buildGeoJson('中关村点位底图', zhongguancunFeatures),
      contentType: 'application/geo+json',
      assign: false,
    });
  });
}

async function main() {
  const config = loadConfig({ port: 0, logRequests: false });
  const app = await createApp(config);
  try {
    const address = await app.listen();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    console.log('');
    console.log('OVERMARKED 演示数据初始化');
    console.log(`数据目录：${config.dataDir}`);

    for (const user of DEMO_USERS) {
      ensureDemoUser(app.db, user, DEMO_PASSWORD);
    }

    const manager = new HttpClient(baseUrl, 'demo_manager');
    const reviewer = new HttpClient(baseUrl, 'demo_reviewer');
    const annotator = new HttpClient(baseUrl, 'demo_annotator');
    await manager.login('demo_manager', DEMO_PASSWORD);
    await reviewer.login('demo_reviewer', DEMO_PASSWORD);
    await annotator.login('demo_annotator', DEMO_PASSWORD);

    const ctx = { manager, reviewer, annotator };

    await seedImageProject(ctx);
    await seedTextProject(ctx);
    await seedAudioProject(ctx);
    await seedSpatialProject(ctx);

    const projectNames = [
      '街景目标检测',
      '科技资讯实体抽取',
      '城市声音片段切分',
      '北京城区空间要素',
    ];
    const list = await manager.request('GET', '/api/projects');
    const seeded = list.projects.filter((project) => projectNames.includes(project.name));

    console.log('');
    console.log('演示项目（待办 / 进行中 / 待复核 / 已通过 / 已驳回 / 总计）');
    for (const project of seeded) {
      const counts = project.counts || {};
      console.log(
        `  ${project.name}：${counts.pending || 0} / ${counts.in_progress || 0} / ${
          counts.submitted || 0
        } / ${counts.approved || 0} / ${counts.rejected || 0} / ${counts.total || 0}`
      );
    }

    const publicPort = process.env.PORT || 8787;
    console.log('');
    console.log(`启动服务：npm start   →   http://127.0.0.1:${publicPort}`);
    console.log(`演示账号（密码 ${DEMO_PASSWORD}）：`);
    console.log('  demo_manager    项目管理员，可建项目、管成员、查看审计');
    console.log('  demo_reviewer   质检员，只能复核已提交条目');
    console.log('  demo_annotator  标注员，只能保存与提交标注');
    const adminFile = path.join(config.dataDir, 'initial-admin.txt');
    if (app.adminBootstrap) {
      console.log(`系统管理员：${app.adminBootstrap.username}，初始密码见 ${adminFile}`);
    } else if (fs.existsSync(adminFile)) {
      console.log(`系统管理员初始密码见 ${adminFile}`);
    }
    console.log('');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('');
  console.error('演示数据初始化失败：', error.stack || error.message);
  process.exitCode = 1;
});
