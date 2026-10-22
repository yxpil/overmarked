import { invalid } from './errors.js';

export const KIND_EXTENSIONS = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
  text: ['txt', 'md', 'csv', 'json', 'jsonl'],
  audio: ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'flac', 'webm'],
  spatial: ['geojson', 'json', 'png', 'jpg', 'jpeg', 'webp'],
};

export const EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/plain',
  json: 'application/json',
  jsonl: 'text/plain',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  webm: 'audio/webm',
  geojson: 'application/geo+json',
};

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

export function detectImageSize(buf) {
  if (!buf || buf.length < 16) return null;
  try {
    if (
      buf.length >= 24 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
    ) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (
      buf.length >= 10 &&
      (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')
    ) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        if (marker === 0xd9 || marker === 0xda) break;
        const length = buf.readUInt16BE(offset + 2);
        if (length < 2) break;
        const isSof =
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf);
        if (isSof && offset + 9 <= buf.length) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
    if (
      buf.length >= 30 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
      }
      if (chunk === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function collectPositions(coordinates, sink) {
  if (!Array.isArray(coordinates)) return;
  if (coordinates.length >= 2 && typeof coordinates[0] === 'number') {
    sink.push(coordinates);
    return;
  }
  for (const child of coordinates) collectPositions(child, sink);
}

function addGeometry(geometry, sink, counters) {
  if (!geometry || typeof geometry !== 'object') return;
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries || []) addGeometry(child, sink, counters);
    return;
  }
  if (geometry.coordinates !== undefined) {
    counters.geometries += 1;
    collectPositions(geometry.coordinates, sink);
  }
}

export function parseGeoJsonBuffer(buf) {
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw invalid('GeoJSON 不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw invalid('GeoJSON 顶层必须是对象');
  const positions = [];
  const counters = { geometries: 0 };
  let featureCount = 0;
  if (parsed.type === 'FeatureCollection') {
    if (!Array.isArray(parsed.features)) throw invalid('FeatureCollection 缺少 features 数组');
    featureCount = parsed.features.length;
    for (const feature of parsed.features) {
      if (feature && feature.type === 'Feature') addGeometry(feature.geometry, positions, counters);
    }
  } else if (parsed.type === 'Feature') {
    featureCount = 1;
    addGeometry(parsed.geometry, positions, counters);
  } else if (['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection'].includes(parsed.type)) {
    featureCount = 1;
    addGeometry(parsed, positions, counters);
  } else {
    throw invalid('不是可识别的 GeoJSON 对象');
  }
  let bounds = null;
  for (const position of positions) {
    const lon = Number(position[0]);
    const lat = Number(position[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw invalid('GeoJSON 坐标必须为数字');
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw invalid('GeoJSON 坐标需为 WGS84 经纬度（EPSG:4326）');
    }
    if (!bounds) bounds = [lon, lat, lon, lat];
    else {
      bounds[0] = Math.min(bounds[0], lon);
      bounds[1] = Math.min(bounds[1], lat);
      bounds[2] = Math.max(bounds[2], lon);
      bounds[3] = Math.max(bounds[3], lat);
    }
  }
  return { featureCount, bounds, geometries: counters.geometries };
}
