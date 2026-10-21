import {urlOrigin,isLocalService} from './model-providers.js';

export const MEDIA_CHANNELS = {
  transcription:{name:'录音转写',model:'qwen3-asr-flash',sample:'一段固定静音示例',hint:'千问支持整场会议录音：原件最大 100 MB、最长 4 小时。程序先在本机转为短段，再逐段上传并合并文字。'},
  vision:{name:'图片识别',model:'qwen3.5-ocr',sample:'一张固定测试图',hint:'识别照片、白板、扫描件中的文字；识别结果可核对修改后再用于文档生成。'}
};
export const QWEN_REGIONS = {
  beijing:{name:'北京 · 公共兼容地址',url:'https://dashscope.aliyuncs.com/compatible-mode/v1'},
  singapore:{name:'新加坡 · 公共兼容地址',url:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'},
  workspace:{name:'控制台工作空间地址',url:''}
};
export function mediaRegion(baseUrl) {
  for(const [id,value] of Object.entries(QWEN_REGIONS))if(value.url&&baseUrl?.replace(/\/$/,'')===value.url)return id;
  return 'workspace';
}
export function readMediaSettings(form,target) {
  const value=suffix=>form.elements[`${target}${suffix}`];
  return {provider:value('Provider').value,baseUrl:value('BaseUrl').value.trim(),model:value('Model').value.trim(),apiKey:value('ApiKey').value.trim(),clearApiKey:value('ClearApiKey').checked};
}
export function mediaConnectionIssues(target,d,saved={},testing=false) {
  const errors={},prefix=name=>`${target}${name}`;
  if(d.provider==='shared'){
    if(testing){
      if(!saved.baseUrl||!saved.model)errors[prefix('Model')]='请先保存文档模型配置，或改用千问独立服务。';
      else if(target==='transcription'&&!d.model)errors[prefix('Model')]='请填写服务商提供的录音转写模型名称。';
    }
    return errors;
  }
  let url;
  try{url=new URL(d.baseUrl);}catch{errors[prefix('BaseUrl')]='请填写控制台提供的完整兼容接口地址。';}
  if(url){
    if(!['http:','https:'].includes(url.protocol)||(!isLocalService(d.baseUrl)&&url.protocol!=='https:'))errors[prefix('BaseUrl')]='云端服务请使用 HTTPS 地址；本机服务可使用 HTTP。';
    else if(url.username||url.password||url.search||url.hash)errors[prefix('BaseUrl')]='地址不能包含账号、密码、查询参数或 # 后缀。';
    else if(/[{}<>]|%7b|%7d/i.test(d.baseUrl))errors[prefix('BaseUrl')]='请将工作空间占位内容替换为控制台中的实际地址。';
    else if(/\/(?:chat\/completions|audio\/transcriptions|responses)\/?$/i.test(url.pathname))errors[prefix('BaseUrl')]='这里只填基础地址，请去掉末尾的具体接口路径。';
    else if(d.provider==='qwen'&&(!/(?:^|\.)(?:aliyuncs\.com|aliyun\.com)$/i.test(url.hostname)||!url.pathname.replace(/\/$/,'').endsWith('/compatible-mode/v1')))errors[prefix('BaseUrl')]='千问请填写百炼兼容地址，以 /compatible-mode/v1 结尾。';
  }
  if(!d.model)errors[prefix('Model')]='请填写控制台提供的完整模型名称。';
  else if(target==='transcription'&&d.provider==='qwen'&&(!/^qwen3-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(d.model)))errors[prefix('Model')]='当前千问转写使用 qwen3-asr-flash（或对应日期版本），不使用 filetrans、realtime 或 paraformer 接口。';
  const sameService=Boolean(urlOrigin(d.baseUrl)&&urlOrigin(d.baseUrl)===urlOrigin(saved[prefix('BaseUrl')]));
  const configured=!!saved[prefix('KeyConfigured')],retained=configured&&sameService&&!d.clearApiKey;
  if(d.clearApiKey&&d.apiKey)errors[prefix('ApiKey')]='填写新密钥和清除密钥不能同时选择。';
  else if(d.provider==='qwen'&&!d.apiKey&&!retained&&!d.clearApiKey)errors[prefix('ApiKey')]='请填写所选地域和工作空间对应的百炼密钥。';
  else if(testing&&d.provider==='qwen'&&!d.apiKey&&!retained)errors[prefix('ApiKey')]='连接测试需要百炼密钥，请填写后再测试。';
  else if(configured&&!sameService&&!d.apiKey&&!d.clearApiKey)errors[prefix('ApiKey')]='地址已改变，请填写新服务的密钥；免密服务请勾选清除原密钥。';
  return errors;
}
export function mediaSettingsMarkup(target,saved,esc) {
  const channel=MEDIA_CHANNELS[target],name=suffix=>`${target}${suffix}`;
  const provider=saved[name('Provider')]||'shared',baseUrl=saved[name('BaseUrl')]||'',model=saved[name('Model')]||'';
  return `<section class="ai-config-panel" data-ai-panel="${target}" id="ai-panel-${target}" role="tabpanel" aria-labelledby="ai-tab-${target}" hidden><div class="ai-config-title"><div><h3>${channel.name}</h3><p class="ai-settings-small">独立配置，不会更改文档模型的地址或密钥。</p></div><button type="button" class="button" data-ai-media-preset="${target}">填入千问推荐参数</button></div><div class="ai-form-stack"><div class="field"><label for="ai-${name('Provider')}">使用的服务</label><select id="ai-${name('Provider')}" name="${name('Provider')}">${[['qwen','阿里云百炼 · 千问'],['shared','沿用文档服务（兼容旧配置）'],['openai','其他兼容服务 / 本机服务']].map(([value,label])=>`<option value="${value}" ${provider===value?'selected':''}>${label}</option>`).join('')}</select></div><div class="ai-provider-help" data-ai-media-shared="${target}"></div><div class="ai-form-stack" data-ai-media-independent="${target}" ${provider==='shared'?'hidden':''}><div class="field" data-ai-media-region="${target}"><label for="ai-${name('Region')}">百炼地域与地址</label><select id="ai-${name('Region')}" name="${name('Region')}">${Object.entries(QWEN_REGIONS).map(([id,region])=>`<option value="${id}" ${mediaRegion(baseUrl)===id?'selected':''}>${region.name}</option>`).join('')}</select><span class="hint">密钥、模型权限、地域及工作空间须对应。部分账号需使用控制台工作空间地址。</span></div><div class="field"><label for="ai-${name('BaseUrl')}">模型服务地址</label><input id="ai-${name('BaseUrl')}" name="${name('BaseUrl')}" type="url" maxlength="2000" value="${esc(baseUrl)}" spellcheck="false" autocomplete="off" aria-describedby="ai-${name('BaseUrl')}-error"><span class="hint" data-ai-media-address-hint="${target}"></span><span class="ai-field-error" id="ai-${name('BaseUrl')}-error"></span></div><div class="field"><div class="ai-field-label"><label for="ai-${name('ApiKey')}">${channel.name}接口密钥</label><a href="https://bailian.console.aliyun.com/" target="_blank" rel="noopener noreferrer">前往百炼控制台 ↗</a></div><div class="ai-key-input"><input id="ai-${name('ApiKey')}" name="${name('ApiKey')}" type="password" autocomplete="new-password" spellcheck="false" maxlength="2000" aria-describedby="ai-${name('ApiKey')}-error"><button type="button" data-ai-media-visibility="${target}" aria-label="显示本次输入的${channel.name}密钥" aria-pressed="false">显示</button></div><span class="hint" data-ai-media-key-hint="${target}"></span><span class="ai-field-error" id="ai-${name('ApiKey')}-error"></span><label class="ai-check ai-clear-key" data-ai-media-clear="${target}"><input type="checkbox" name="${name('ClearApiKey')}"><span>保存时清除这个通道已保存的密钥</span></label></div></div><div class="field"><label for="ai-${name('Model')}">${channel.name}模型名称</label><input id="ai-${name('Model')}" name="${name('Model')}" value="${esc(model)}" maxlength="200" spellcheck="false" autocomplete="off" placeholder="例如 ${channel.model}" aria-describedby="ai-${name('Model')}-error"><span class="hint">模型名称可以修改，请以控制台已开通的模型为准。${target==='vision'?'沿用文档服务时可留空，使用文档模型。':''}</span><span class="ai-field-error" id="ai-${name('Model')}-error"></span></div><div class="ai-note" data-ai-media-limits="${target}">${channel.hint}</div></div></section>`;
}
