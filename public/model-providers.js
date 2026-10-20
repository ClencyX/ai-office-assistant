// 模型服务的界面预设。只在用户选择或应用推荐参数时使用，不自动更改已保存配置。
export const MODEL_PROVIDERS = [
  {id:'deepseek',name:'DeepSeek 云端',description:'在线使用，需申请密钥',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},
  {id:'ollama',name:'本机 Ollama',description:'本机运行，通常无需密钥',baseUrl:'http://localhost:11434/v1',model:''},
  {id:'custom',name:'其他兼容服务',description:'按服务商说明填写',baseUrl:'',model:''}
];
export const DEEPSEEK_MODELS = [
  {id:'deepseek-flash',name:'日常办公（推荐）'},
  {id:'deepseek-v4-pro',name:'复杂分析'}
];
export function urlOrigin(value) {
  try{return new URL(value).origin;}catch{return '';}
}
export function isLocalService(value) {
  try{return ['localhost','127.0.0.1','[::1]','::1'].includes(new URL(value).hostname);}catch{return false;}
}
export function inferProvider(value) {
  try{
    const u=new URL(value);
    if(u.hostname==='api.deepseek.com')return 'deepseek';
    if(isLocalService(value)&&u.port==='11434')return 'ollama';
  }catch{/* 无效地址保留在自定义表单中，供用户修正。 */}
  return 'custom';
}
export function connectionIssues({baseUrl,model,apiKey,clearApiKey,enabled=true},saved={},{testing=false}={}) {
  const errors={};
  const active=enabled||testing;
  let url;
  try{url=new URL(baseUrl);}catch{errors.baseUrl='请填写完整地址，例如 https://api.deepseek.com。';}
  if(url){
    if(!['http:','https:'].includes(url.protocol)||(!isLocalService(baseUrl)&&url.protocol!=='https:'))errors.baseUrl='云端服务请使用 HTTPS 地址；本机服务可以使用 HTTP。';
    else if(url.username||url.password||url.search||url.hash)errors.baseUrl='服务地址不能包含账号、密码、查询参数或 # 后缀。';
    else if(/\/(?:chat\/completions|audio\/transcriptions|responses)\/?$/i.test(url.pathname))errors.baseUrl='这里只填基础地址，请去掉末尾的 /chat/completions、/audio/transcriptions 或 /responses。';
    else if(url.hostname==='api.deepseek.com'&&!['','/','/v1','/v1/'].includes(url.pathname))errors.baseUrl='DeepSeek 基础地址请填 https://api.deepseek.com 或 https://api.deepseek.com/v1。';
  }
  if(active&&!model.trim())errors.model=isLocalService(baseUrl)?'请填写本机已安装的完整模型名称，可在 Ollama 中查看。':'请选择模型，或填写服务商提供的完整模型名称。';
  else if(active&&url?.hostname==='api.deepseek.com'&&model.trim().toLowerCase()==='deepseek')errors.model='deepseek 是服务名称。请选用 deepseek-flash 或填写完整模型编号。';
  const sameService=Boolean(urlOrigin(baseUrl)&&urlOrigin(baseUrl)===urlOrigin(saved.baseUrl));
  const hasSavedKey=saved.keyConfigured&&sameService&&!clearApiKey;
  if(clearApiKey&&apiKey?.trim())errors.apiKey='更换密钥和清除密钥不能同时选择，请取消清除或清空输入框。';
  else if(active&&url?.hostname==='api.deepseek.com'&&!apiKey?.trim()&&!hasSavedKey)errors.apiKey=saved.keyConfigured&&!sameService?'已切换服务地址，请填写新服务的密钥；原密钥不会发给新服务。':'DeepSeek 云端需要接口密钥，请从服务商控制台获取后粘贴。';
  else if(saved.keyConfigured&&!sameService&&!apiKey?.trim()&&!clearApiKey)errors.apiKey='服务地址已改变，请填写新服务的密钥；若新服务免密，请勾选清除原密钥。';
  return errors;
}
