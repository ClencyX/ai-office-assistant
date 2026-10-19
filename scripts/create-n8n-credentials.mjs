import { writeFileSync } from 'node:fs';
const key = process.env.AUTOMATION_KEY;
if (!key || key.length < 32) throw new Error('内部调度密钥缺失，请先运行平台启动脚本。');
writeFileSync(process.argv[2], JSON.stringify([{
  id: 'officeAutomationHeader',
  name: '办公平台内部调度密钥',
  type: 'httpHeaderAuth',
  data: { name: 'x-automation-key', value: key },
}]), { mode: 0o600 });
