import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = await createApp(config);

try {
  const address = await app.listen();
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log('');
  console.log('  OVERMARKED — annotation workbench');
  console.log(`  http://${host}:${address.port}`);
  console.log(`  data: ${config.dataDir}`);
  if (app.adminBootstrap) {
    console.log('');
    console.log(`  已创建管理员账号：${app.adminBootstrap.username}`);
    if (app.adminBootstrap.passwordFile) {
      console.log(`  初始密码已写入：${app.adminBootstrap.passwordFile}`);
    } else {
      console.log('  密码来自 ADMIN_PASSWORD 环境变量');
    }
    console.log('  登录后请立即修改密码。');
  }
  console.log('');
} catch (error) {
  console.error('启动失败：', error.message);
  await app.close();
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在关闭…`);
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
