import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfficeStore } from '../lib/office.mjs';
import { validateFiles } from '../lib/attachments.mjs';
import { createApplication } from '../server.mjs';

const clock=()=>new Date('2026-10-19T03:00:00Z');
const taskInput=(extra={})=>({title:'提交材料验收',owner:'经办人',startDate:'2026-10-19',dueDate:'2026-10-19',deliverable:'提交经核对的工作成果。',...extra});
const file=(name,content)=>({name,contentBase64:Buffer.from(content).toString('base64')});
const textFile=()=>file('成果.txt','已完成本次任务，材料核对无误。');
const payload=(files=[textFile()])=>({confirmed:true,note:'内容已核对',files});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'office-submission-'));const store=new OfficeStore({databasePath:join(dir,'office.sqlite'),seedDemo:false,now:clock});t.after(async()=>{try{store.close();}catch{}await rm(dir,{recursive:true,force:true});});return {dir,store};}
function crc32(data){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
// Generate tiny, real ZIP containers for Office-format interoperability tests.
function zip(entries){const local=[],central=[];let offset=0;for(const [path,text]of Object.entries(entries)){const name=Buffer.from(path),body=Buffer.from(text),crc=crc32(body),header=Buffer.alloc(30),directory=Buffer.alloc(46);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(body.length,18);header.writeUInt32LE(body.length,22);header.writeUInt16LE(name.length,26);directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(body.length,20);directory.writeUInt32LE(body.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);local.push(header,name,body);central.push(directory,name);offset+=header.length+name.length+body.length;}const end=Buffer.alloc(22),centralBuffer=Buffer.concat(central);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(centralBuffer.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,centralBuffer,end]);}
const wordZip=()=>zip({'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>','word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>工作成果</w:t></w:r></w:p></w:body></w:document>'});
const sheetZip=()=>zip({'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>','xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>'});
function wordOle(){
  const data=Buffer.alloc(11*512);data.write('d0cf11e0a1b11ae1',0,'hex');data.writeUInt16LE(0x3e,24);data.writeUInt16LE(3,26);data.writeUInt16LE(0xfffe,28);data.writeUInt16LE(9,30);data.writeUInt16LE(6,32);
  data.writeUInt32LE(1,44);data.writeUInt32LE(1,48);data.writeUInt32LE(4096,56);data.writeUInt32LE(0xfffffffe,60);data.writeUInt32LE(0xfffffffe,68);data.fill(0xff,76,512);data.writeUInt32LE(0,76);
  data.fill(0xff,512,1024);data.writeUInt32LE(0xfffffffd,512);data.writeUInt32LE(0xfffffffe,516);for(let i=2;i<=9;i++)data.writeUInt32LE(i===9?0xfffffffe:i+1,512+i*4);
  const root=1024,stream=1152;data.write('Root Entry',root,'utf16le');data.writeUInt16LE(22,root+64);data[root+66]=5;data[root+67]=1;data.writeUInt32LE(0xffffffff,root+68);data.writeUInt32LE(0xffffffff,root+72);data.writeUInt32LE(1,root+76);data.writeUInt32LE(0xfffffffe,root+116);
  data.write('WordDocument',stream,'utf16le');data.writeUInt16LE(26,stream+64);data[stream+66]=2;data[stream+67]=1;data.fill(0xff,stream+68,stream+80);data.writeUInt32LE(2,stream+116);data.writeUInt32LE(4096,stream+120);return data;
}

test('未上传、未确认、普通创建和更新都不能绕过完成，失败保持原状态和文件数',async t=>{
  const {store}=await fixture(t);assert.throws(()=>store.createTask(taskInput({status:'已完成'})),/上传/);
  const task=store.createTask(taskInput({status:'进行中',submissionType:'表格'}));
  assert.throws(()=>store.updateTask(task.id,{status:'已完成'}),/上传/);
  for(const body of [{files:[],confirmed:true},{files:[file('结果.csv','项目,数量\n验收,1')],confirmed:false},payload([textFile()]),payload([file('伪装.xlsx','这是普通文本')]),payload([file('结果.csv','项目,数量\n验收,1'),file('失败.xls','损坏文件')])])assert.throws(()=>store.completeTask(task.id,body));
  assert.equal(store.getTask(task.id).status,'进行中');assert.equal(store.getTask(task.id).attachments.length,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM attachments').get().count,0);
});
test('上传、完成与原文件持久化同一事务，下载元数据不泄漏文件，重开必须重新提交',async t=>{
  const {store}=await fixture(t);const task=store.createTask(taskInput({submissionType:'表格'}));store.run();
  const csv=file('统计结果.CSV','项目,数量\n完成,12');let result=store.completeTask(task.id,payload([csv]));
  assert.equal(result.status,'已完成');assert.ok(result.completedAt);assert.equal(result.attachments.length,1);assert.equal(result.completionLegacy,false);assert.equal(store.state().reminders[0].read,true);
  const attachment=store.getAttachment(result.attachments[0].id);assert.equal(Buffer.from(attachment.content).toString(),Buffer.from(csv.contentBase64,'base64').toString());assert.equal(attachment.mimeType,'text/csv; charset=utf-8');
  assert.equal(JSON.stringify(store.state()).includes('contentBase64'),false);assert.equal(Object.hasOwn(result.attachments[0],'content'),false);
  assert.throws(()=>store.completeTask(task.id,payload([csv])),/已完成/);result=store.updateTask(task.id,{title:'编辑已完成任务',owner:'接任人'});assert.equal(result.status,'已完成');
  assert.throws(()=>store.updateTask(task.id,{submissionType:'文本'}),/重新打开/);store.updateTask(task.id,{status:'进行中',submissionType:'文本'});
  assert.throws(()=>store.completeTask(task.id,payload([])));assert.equal(store.getTask(task.id).attachments.length,1);
  result=store.completeTask(task.id,payload());assert.equal(result.attachments.length,2);assert.ok(store.state().events.some(e=>e.action==='完成任务'&&e.detail.includes('确认')));
});
test('真实Office容器识别类型，改扩展名和伪文档不能完成',()=>{
  assert.equal(validateFiles([file('成果.docx',wordZip())],'文本')[0].mimeType.includes('wordprocessingml'),true);
  assert.equal(validateFiles([file('成果.xlsx',sheetZip())],'表格')[0].mimeType.includes('spreadsheetml'),true);
  assert.throws(()=>validateFiles([file('伪装.xlsx',wordZip())],'表格'),/内容与格式不符/);
  assert.throws(()=>validateFiles([file('空.pdf','%PDF-1.7\n%%EOF')],'PDF'),/内容与格式不符/);
  assert.throws(()=>validateFiles([file('空.doc',Buffer.from('d0cf11e0a1b11ae1','hex'))],'文本'),/内容与格式不符/);
  assert.throws(()=>validateFiles([file('空.txt','   ')],'文本'),/内容与格式不符/);
  assert.throws(()=>validateFiles([file('../成果.txt','成果')],'文本'),/文件名/);
  assert.throws(()=>validateFiles([file('程序.exe','文件')],'不限'),/不符合/);
});
test('传统Office扇区列表拒绝重复、越界和超额声明，不能把小文件放大到巨量内存',()=>{
  const valid=wordOle();assert.equal(validateFiles([file('成果.doc',valid)],'文本')[0].size,valid.length);
  const duplicate=Buffer.from(valid);duplicate.writeUInt32LE(2,44);duplicate.writeUInt32LE(0,80);assert.throws(()=>validateFiles([file('重复扇区.doc',duplicate)],'文本'),/内容与格式不符/);
  const outOfBounds=Buffer.from(valid);outOfBounds.writeUInt32LE(10,76);assert.throws(()=>validateFiles([file('越界扇区.doc',outOfBounds)],'文本'),/内容与格式不符/);
  const overlap=Buffer.from(valid);overlap.writeUInt32LE(0,68);overlap.writeUInt32LE(1,72);assert.throws(()=>validateFiles([file('扇区重叠.doc',overlap)],'文本'),/内容与格式不符/);
  const difatCount=126,amplified=Buffer.alloc((difatCount+3)*512);valid.copy(amplified,0,0,76);amplified.writeUInt32LE(109+difatCount*127,44);amplified.writeUInt32LE(difatCount+1,48);amplified.writeUInt32LE(1,68);amplified.writeUInt32LE(difatCount,72);
  for(let i=1;i<=difatCount;i++)amplified.writeUInt32LE(i===difatCount?0xfffffffe:i+1,(i+1)*512+508);
  amplified.writeUInt32LE(0xfffffffe,512+(difatCount+1)*4);const directory=(difatCount+2)*512;amplified.write('WordDocument',directory,'utf16le');amplified.writeUInt16LE(26,directory+64);amplified[directory+66]=2;
  assert.equal(amplified.length,66048);assert.throws(()=>validateFiles([file('内存放大.doc',amplified)],'文本'),/内容与格式不符/);
});
test('大文件和批量限制明确，合法的大文本不会触发编码校验栈溢出',()=>{
  const large=Buffer.alloc(1024*1024,0x61);assert.equal(validateFiles([file('大型文本.txt',large)],'文本')[0].size,large.length);
  assert.throws(()=>validateFiles(Array.from({length:6},()=>textFile()),'文本'),/1 至 5/);
  assert.throws(()=>validateFiles([{name:'过大.txt',contentBase64:'A'.repeat(Math.ceil(10*1024*1024/3)*4+4)}],'文本'),/超过 10/);
  assert.throws(()=>validateFiles([{name:'编码错误.txt',contentBase64:'===='}],'文本'),/编码/);
});
test('历史完成记录可继续编辑，重新打开后仍必须上传；提交形式新旧导入与周期继承正确',async t=>{
  const {store}=await fixture(t);let task=store.createTask(taskInput());store.db.prepare("UPDATE tasks SET status='已完成',completedAt=? WHERE id=?").run(clock().toISOString(),task.id);
  task=store.getTask(task.id);assert.equal(task.completionLegacy,true);assert.equal(store.updateTask(task.id,{owner:'新负责人'}).status,'已完成');store.updateTask(task.id,{status:'待办'});assert.throws(()=>store.updateTask(task.id,{status:'已完成'}),/上传/);
  const headers='任务名称,负责人,首次开始日期,完成天数,周期,交付要求,';
  store.importTemplates({csv:headers+'提交形式\n按周统计,经办人,2026-10-19,1,每周,提交统计表,表格'});store.importTemplates({csv:headers+'优先级\n旧模板,经办人,2026-10-19,1,每月,提交汇报,高'});store.run();
  assert.equal(store.state().tasks.find(t=>t.title==='按周统计').submissionType,'表格');assert.equal(store.state().tasks.find(t=>t.title==='旧模板').submissionType,'文本');assert.match(store.exportTasks(),/提交形式/);assert.doesNotMatch(store.exportTasks().split('\n')[0],/优先级/);
});
test('一致性备份包含文件原内容，回收站保留文件且恢复后可重新下载',async t=>{
  const {dir,store}=await fixture(t);const task=store.createTask(taskInput());const result=store.completeTask(task.id,payload());const id=result.attachments[0].id,original=Buffer.from(store.getAttachment(id).content);
  store.deleteTask(task.id);assert.throws(()=>store.getAttachment(id),/未找到/);assert.equal(store.trash().tasks[0].attachments.length,1);store.restoreTask(task.id);assert.deepEqual(Buffer.from(store.getAttachment(id).content),original);
  const backup=join(dir,'backup.sqlite');store.createBackup(backup);const restored=new OfficeStore({databasePath:backup,seedDemo:false,now:clock});try{assert.deepEqual(Buffer.from(restored.getAttachment(id).content),original);assert.equal(restored.getTask(task.id).status,'已完成');assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{restored.close();}
});
test('HTTP完成强制同源与材料、下载按附件输出，状态不返回文档内容',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'office-upload-http-'));const app=createApplication({port:0,dataDir:dir,seedDemo:false,scheduler:'external',now:clock});const address=await app.start(),base=`http://127.0.0.1:${address.port}`;t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const send=(path,body,method='POST',headers={})=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await send('/api/tasks',taskInput({status:'已完成'}))).status,400);
  const {task}=await(await send('/api/tasks',taskInput({status:'进行中'}))).json();const complete=`/api/tasks/${task.id}/complete`;
  assert.equal((await send(`/api/tasks/${task.id}`,{status:'已完成'},'PATCH')).status,400);assert.equal((await send(complete,payload(),'POST',{Origin:'https://other.invalid'})).status,403);assert.equal((await send(complete,{confirmed:true,files:[]})).status,400);
  const response=await send(complete,payload());assert.equal(response.status,200);const completed=(await response.json()).task;assert.equal(completed.status,'已完成');
  const fileResponse=await fetch(base+`/api/attachments/${completed.attachments[0].id}`);assert.equal(fileResponse.status,200);assert.match(fileResponse.headers.get('content-disposition'),/^attachment;/);assert.equal(await fileResponse.text(),'已完成本次任务，材料核对无误。');
  const state=await(await fetch(base+'/api/state')).json();assert.equal(state.tasks[0].attachments.length,1);assert.equal(JSON.stringify(state).includes('contentBase64'),false);
});
