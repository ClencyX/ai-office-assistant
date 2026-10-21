import {MODEL_PROVIDERS,DEEPSEEK_MODELS,urlOrigin,isLocalService,inferProvider,connectionIssues} from './model-providers.js';
import {MEDIA_CHANNELS,QWEN_REGIONS,mediaRegion,readMediaSettings,mediaConnectionIssues,mediaSettingsMarkup} from './ai-media-settings.js';

// 设置窗口中的草稿和测试状态只存在于当前窗口，不将密钥存入页面持久化存储。
export function createModelSettings(ui) {
  const {esc,openDrawer,action,request,getSettings,saveSettings,testConnection,rerender}=ui;
  let saved={},provider='custom',drafts=new Map(),mediaDrafts=new Map(),target='text',statuses=new Map();
  const field=(label,name,value,hint,extra='')=>`<div class="field"><label for="ai-${name}">${label}</label><input id="ai-${name}" name="${name}" value="${esc(value||'')}" ${extra}><span class="hint" id="ai-${name}-hint">${hint}</span><span class="ai-field-error" id="ai-${name}-error"></span></div>`;
  const read=form=>({enabled:form.elements.enabled.checked,baseUrl:form.elements.baseUrl.value.trim(),model:form.elements.model.value.trim(),apiKey:form.elements.apiKey.value.trim(),clearApiKey:form.elements.clearApiKey.checked});
  function open() {
    saved={...getSettings()};provider=inferProvider(saved.baseUrl);drafts=new Map();mediaDrafts=new Map();target='text';statuses=new Map();
    const s={enabled:!!saved.enabled,baseUrl:saved.baseUrl||'',model:saved.model||'',transcriptionModel:saved.transcriptionModel||'',visionModel:saved.visionModel||'',apiKey:'',clearApiKey:false};
    openDrawer('配置 AI 模型',`<form id="ai-settings-form" novalidate><p class="ai-settings-intro">文档、录音和图片可以分别选择服务。每次只保存当前页的配置，密钥仅保存在本机。</p><div class="ai-config-enabled"><label class="ai-check"><input name="enabled" type="checkbox" ${s.enabled?'checked':''}><span>启用 AI 辅助功能</span></label><p class="ai-settings-small">此开关同时控制文档生成、录音转写和图片识别；停用时仍可测试连接。保存当前页时开关一起生效。</p></div><div class="ai-config-tabs" role="tablist" aria-label="模型用途">${[['text','文档生成'],['transcription','录音转写'],['vision','图片识别']].map(([id,label])=>`<button type="button" id="ai-tab-${id}" role="tab" aria-selected="${id==='text'}" aria-controls="ai-panel-${id}" tabindex="${id==='text'?0:-1}" data-ai-config-tab="${id}">${label}</button>`).join('')}</div><div class="form-error" role="alert"></div><div data-ai-panel="text" id="ai-panel-text" role="tabpanel" aria-labelledby="ai-tab-text"><section class="ai-settings-step"><div class="ai-step-heading"><span>1</span><h3>选择模型服务</h3></div><div class="ai-provider-options" role="group" aria-label="选择模型服务">${MODEL_PROVIDERS.map(p=>`<label class="ai-provider ${provider===p.id?'is-selected':''}"><input type="radio" name="provider" value="${p.id}" ${provider===p.id?'checked':''}><span><strong>${p.name}</strong><small>${p.description}</small></span></label>`).join('')}</div><p class="ai-settings-small">切换服务会保留各自本次填写的内容；点击保存后才会生效。</p></section><section class="ai-settings-step"><div class="ai-step-heading"><span>2</span><h3>填写接入信息</h3><button type="button" class="ai-settings-link" id="ai-use-defaults">使用推荐参数</button></div><div id="ai-provider-help" class="ai-provider-help"></div><div class="ai-form-stack">${field('模型服务地址','baseUrl',s.baseUrl,'','type="url" maxlength="2000" spellcheck="false" autocomplete="off" aria-describedby="ai-baseUrl-hint ai-baseUrl-error"')}<div id="ai-model-select-field" class="field"><label for="ai-model-choice">文档模型</label><select id="ai-model-choice">${DEEPSEEK_MODELS.map(m=>`<option value="${m.id}">${m.name} · ${m.id}</option>`).join('')}<option value="custom">填写其他模型名称</option></select><span class="hint">日常整理会议纪要、起草材料，可先选择推荐模型。</span></div><div id="ai-model-input-field">${field('完整模型名称','model',s.model,'','maxlength="200" spellcheck="false" autocomplete="off" aria-describedby="ai-model-hint ai-model-error"')}</div><div id="ai-model-selection-error" class="ai-field-error"></div><div class="field"><div class="ai-field-label"><label for="ai-apiKey" id="ai-key-label">接口密钥</label><a id="ai-key-link" href="https://platform.deepseek.com/" target="_blank" rel="noopener noreferrer">前往 DeepSeek 获取密钥 ↗</a></div><div class="ai-key-input"><input id="ai-apiKey" name="apiKey" type="password" autocomplete="new-password" maxlength="2000" spellcheck="false" aria-describedby="ai-key-hint ai-apiKey-error"><button type="button" id="ai-key-visibility" aria-label="显示本次输入的密钥" aria-pressed="false">显示</button></div><span class="hint" id="ai-key-hint"></span><span class="ai-field-error" id="ai-apiKey-error"></span><label class="ai-check ai-clear-key" id="ai-clear-key-row"><input type="checkbox" name="clearApiKey"><span id="ai-clear-key-label">保存时清除原密钥</span></label></div></div></section></div>${mediaSettingsMarkup('transcription',saved,esc)}${mediaSettingsMarkup('vision',saved,esc)}<section class="ai-settings-step ai-settings-test"><div class="ai-step-heading"><span>3</span><h3>保存并验证连接</h3></div><div class="ai-connection-status" id="ai-connection-status" role="status" aria-live="polite"><strong>尚未测试连接</strong><p>保存仅将配置写入本机，连接是否可用需通过测试确认。</p></div><p class="ai-settings-small" id="ai-test-destination"></p><label class="ai-check"><input type="checkbox" name="consent"><span id="ai-test-consent-label">同意发送一段固定虚构文字测试文档模型连接</span></label><p class="ai-settings-small">测试仅使用程序内置示例，不读取任务、素材或文档。服务商可能按请求计费。保存设置不会调用模型。</p></section></form>`,`${action('close','关闭','button')}<button type="submit" form="ai-settings-form" class="button" id="ai-config-save" value="save">保存文档设置</button><button type="submit" form="ai-settings-form" class="button primary" id="ai-config-test" value="test">保存并测试文档</button>`);
    const form=document.querySelector('#ai-settings-form');
    form.closest('.drawer').classList.add('ai-settings-dialog');
    form.addEventListener('submit',e=>{form.dataset.submitMode=e.submitter?.value||'save';});
    form.addEventListener('input',e=>{
      if(['provider','consent'].includes(e.target.name))return;
      form.elements.consent.checked=false;
      if(e.target.name==='transcriptionBaseUrl'||e.target.name==='visionBaseUrl')form.elements[e.target.name.replace('BaseUrl','Region')].value=mediaRegion(e.target.value.trim());
      markChanged(form);updateHints(form);clearFieldError(form,e.target.name);
    });
    form.addEventListener('change',e=>{
      if(e.target.name==='provider'){switchProvider(form,e.target.value);return;}
      for(const kind of Object.keys(MEDIA_CHANNELS)){
        if(e.target.name===`${kind}Provider`){switchMediaProvider(form,kind,e.target.value);return;}
        if(e.target.name===`${kind}Region`){
          const region=QWEN_REGIONS[e.target.value];
          if(region){form.elements[`${kind}BaseUrl`].value=region.url;form.elements[`${kind}ApiKey`].value='';}
          form.elements.consent.checked=false;markChanged(form);updateHints(form);clearErrors(form);
          if(e.target.value==='workspace')form.elements[`${kind}BaseUrl`].focus();return;
        }
        if(e.target.name===`${kind}ClearApiKey`){form.elements.consent.checked=false;markChanged(form);updateHints(form);clearFieldError(form,`${kind}ApiKey`);return;}
      }
      if(e.target.id==='ai-model-choice'){
        if(e.target.value!=='custom')form.elements.model.value=e.target.value;
        else form.elements.model.value=DEEPSEEK_MODELS.some(m=>m.id===form.elements.model.value)?'':form.elements.model.value;
        form.elements.consent.checked=false;markChanged(form);updateHints(form);clearFieldError(form,'model');
        if(e.target.value==='custom')form.elements.model.focus();
      }
      if(e.target.name==='clearApiKey'){form.elements.consent.checked=false;markChanged(form);updateHints(form);clearFieldError(form,'apiKey');}
    });
    form.querySelector('#ai-use-defaults').addEventListener('click',()=>{
      const p=MODEL_PROVIDERS.find(p=>p.id===provider);if(!p||p.id==='custom')return;
      form.elements.baseUrl.value=p.baseUrl;form.elements.model.value=p.model;
      form.elements.consent.checked=false;
      markChanged(form);syncModelChoice(form);updateHints(form);clearErrors(form);
    });
    form.querySelector('#ai-key-visibility').addEventListener('click',e=>{
      const input=form.elements.apiKey,show=input.type==='password';input.type=show?'text':'password';
      e.currentTarget.textContent=show?'隐藏':'显示';e.currentTarget.setAttribute('aria-pressed',String(show));e.currentTarget.setAttribute('aria-label',`${show?'隐藏':'显示'}本次输入的密钥`);
    });
    form.querySelectorAll('[data-ai-config-tab]').forEach(button=>{
      button.addEventListener('click',()=>switchTab(form,button.dataset.aiConfigTab));
      button.addEventListener('keydown',e=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
        e.preventDefault();const tabs=[...form.querySelectorAll('[data-ai-config-tab]')],index=tabs.indexOf(button);
        const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;
        switchTab(form,tabs[next].dataset.aiConfigTab);tabs[next].focus();
      });
    });
    form.querySelectorAll('[data-ai-media-preset]').forEach(button=>button.addEventListener('click',()=>{
      const kind=button.dataset.aiMediaPreset;form.elements[`${kind}Provider`].value='qwen';switchMediaProvider(form,kind,'qwen',true);
    }));
    form.querySelectorAll('[data-ai-media-visibility]').forEach(button=>button.addEventListener('click',()=>{
      const kind=button.dataset.aiMediaVisibility,input=form.elements[`${kind}ApiKey`],show=input.type==='password';
      input.type=show?'text':'password';button.textContent=show?'隐藏':'显示';button.setAttribute('aria-pressed',String(show));button.setAttribute('aria-label',`${show?'隐藏':'显示'}本次输入的${MEDIA_CHANNELS[kind].name}密钥`);
    }));
    for(const kind of Object.keys(MEDIA_CHANNELS))form.elements[`${kind}Provider`].dataset.previous=form.elements[`${kind}Provider`].value;
    syncModelChoice(form);updateHints(form);
    if(provider==='deepseek'&&s.model==='deepseek')setFieldError(form,'model','deepseek 是服务名称，请选择完整模型编号。');
  }
  function syncModelChoice(form) {
    form.querySelector('#ai-model-choice').value=DEEPSEEK_MODELS.some(m=>m.id===form.elements.model.value)?form.elements.model.value:'custom';
  }
  function switchTab(form,next) {
    target=next;form.dataset.target=target;form.elements.consent.checked=false;clearErrors(form);
    form.querySelectorAll('[data-ai-panel]').forEach(panel=>panel.hidden=panel.dataset.aiPanel!==target);
    form.querySelectorAll('[data-ai-config-tab]').forEach(button=>{const active=button.dataset.aiConfigTab===target;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
    const name=target==='text'?'文档':MEDIA_CHANNELS[target].name;
    document.querySelector('#ai-config-save').textContent=`保存${name}设置`;
    document.querySelector('#ai-config-test').textContent=`保存并测试${name}`;
    const prior=statuses.get(target);
    if(prior)showStatus(form,...prior);else showStatus(form,'pending','尚未测试这个模型','保存只写入本机；测试仅发送程序内置示例。');
    updateHints(form);
  }
  function switchMediaProvider(form,kind,next,recommended=false) {
    const select=form.elements[`${kind}Provider`],previous=select.dataset.previous||'shared';
    const current=readMediaSettings(form,kind);current.provider=previous;mediaDrafts.set(`${kind}:${previous}`,current);
    let d=mediaDrafts.get(`${kind}:${next}`);
    if(!d)d={provider:next,baseUrl:next==='qwen'?QWEN_REGIONS.beijing.url:'',model:next==='qwen'?MEDIA_CHANNELS[kind].model:'',apiKey:'',clearApiKey:false};
    if(recommended)d={...d,provider:'qwen',baseUrl:QWEN_REGIONS.beijing.url,model:MEDIA_CHANNELS[kind].model,apiKey:next===previous&&urlOrigin(current.baseUrl)===urlOrigin(QWEN_REGIONS.beijing.url)?current.apiKey:'',clearApiKey:false};
    for(const [suffix,key] of [['BaseUrl','baseUrl'],['Model','model'],['ApiKey','apiKey']])form.elements[`${kind}${suffix}`].value=d[key]||'';
    form.elements[`${kind}ClearApiKey`].checked=!!d.clearApiKey;select.dataset.previous=next;
    form.elements[`${kind}Region`].value=mediaRegion(d.baseUrl);
    const input=form.elements[`${kind}ApiKey`],visibility=form.querySelector(`[data-ai-media-visibility="${kind}"]`);input.type='password';visibility.textContent='显示';visibility.setAttribute('aria-pressed','false');visibility.setAttribute('aria-label',`显示本次输入的${MEDIA_CHANNELS[kind].name}密钥`);
    form.elements.consent.checked=false;markChanged(form);updateHints(form);clearErrors(form);
  }
  function switchProvider(form,next) {
    drafts.set(provider,read(form));provider=next;
    const p=MODEL_PROVIDERS.find(p=>p.id===provider);
    const d=drafts.get(provider)||{...read(form),baseUrl:p.baseUrl,model:p.model,apiKey:'',clearApiKey:provider==='ollama'&&saved.keyConfigured&&urlOrigin(saved.baseUrl)!==urlOrigin(p.baseUrl)};
    for(const name of ['baseUrl','model','apiKey'])form.elements[name].value=d[name]||'';
    form.elements.clearApiKey.checked=!!d.clearApiKey;
    form.elements.apiKey.type='password';
    const visibility=form.querySelector('#ai-key-visibility');visibility.textContent='显示';visibility.setAttribute('aria-pressed','false');visibility.setAttribute('aria-label','显示本次输入的密钥');
    form.querySelectorAll('.ai-provider').forEach(el=>el.classList.toggle('is-selected',el.querySelector('input').value===provider));
    form.elements.consent.checked=false;markChanged(form);syncModelChoice(form);updateHints(form);clearErrors(form);
  }
  function markChanged(form) {
    setStatus(form,'pending','配置有未保存修改','修改后请重新保存并测试，之前的测试结果不适用于当前配置。');
    form.querySelector('.form-error').textContent='';
  }
  function setStatus(form,type,title,text) {
    statuses.set(target,[type,title,text]);showStatus(form,type,title,text);
  }
  function showStatus(form,type,title,text) {
    const el=form.querySelector('#ai-connection-status');el.className=`ai-connection-status ${type}`;
    el.querySelector('strong').textContent=title;el.querySelector('p').textContent=text;
  }
  function updateHints(form) {
    const d=read(form),local=isLocalService(d.baseUrl),same=Boolean(urlOrigin(d.baseUrl)&&urlOrigin(d.baseUrl)===urlOrigin(saved.baseUrl));
    const deepseek=provider==='deepseek',deepseekAddress=inferProvider(d.baseUrl)==='deepseek';
    const help=form.querySelector('#ai-provider-help');
    help.textContent=deepseek?'在 DeepSeek 控制台创建密钥，复制到下方，再选择文档模型。':provider==='ollama'?'先启动本机 Ollama 并安装模型。将已安装模型的完整名称填写到下方，例如从 Ollama 模型列表复制。':'选择支持兼容接口的服务，将它提供的基础地址、完整模型名称和密钥填写到下方。';
    form.querySelector('#ai-use-defaults').hidden=provider==='custom';
    form.querySelector('#ai-baseUrl-hint').textContent=deepseek?'已预填官方基础地址，通常无需修改。这里不填写 /chat/completions。':local?'本机 Ollama 常用地址：http://localhost:11434/v1。程序和模型需在同一台电脑运行。':'这是程序访问模型的入口，请填写服务商提供的基础地址，通常以 /v1 结尾。';
    form.querySelector('#ai-model-select-field').hidden=!deepseek;
    const custom=!deepseek||form.querySelector('#ai-model-choice').value==='custom';
    form.querySelector('#ai-model-input-field').hidden=!custom;
    form.querySelector('#ai-model-hint').textContent=local?'请与本机安装的模型名称完全一致，包括版本后缀。':'模型名称是服务商提供的调用编号，不能只填写品牌名称。';
    form.querySelector('#ai-key-label').textContent=deepseekAddress?`接口密钥（${d.enabled?'必填':'启用时必填'}）`:local?'接口密钥（本机通常免填）':'接口密钥（按服务商要求填写）';
    form.querySelector('#ai-key-link').hidden=!deepseek;
    form.querySelector('#ai-key-hint').textContent=saved.keyConfigured&&same&&!d.clearApiKey?'本机已保存密钥，留空可沿用；填写新密钥会替换。已保存内容不会回显。':saved.keyConfigured&&!same?local?'切换到本机服务后，保存时会按下方选项清除原服务密钥。':'服务地址已改变，请填写新服务的密钥；若新服务免密，请勾选清除原密钥。':local?'本机免密服务可留空；密钥只会保存在本机。':deepseekAddress?'从 DeepSeek 控制台复制完整密钥，仅保存在本机，页面不会回显。':'按服务商要求填写；免密服务可留空。密钥仅保存在本机，页面不会回显。';
    form.elements.apiKey.placeholder=saved.keyConfigured&&same&&!d.clearApiKey?'留空保留已保存的密钥':local?'免密服务可留空':'粘贴服务商提供的接口密钥';
    form.querySelector('#ai-clear-key-row').hidden=!saved.keyConfigured;
    form.querySelector('#ai-clear-key-label').textContent=local&&!same?'保存时清除原服务密钥（本机免密服务）':'保存时清除已保存的密钥';
    for(const kind of Object.keys(MEDIA_CHANNELS))updateMediaHints(form,kind);
    if(target==='text'){
      form.querySelector('#ai-test-destination').textContent=`测试发往：${d.baseUrl||'请填写服务地址'} · 模型：${d.model||'请选择或填写模型'}`;
      form.querySelector('#ai-test-consent-label').textContent='同意发送一段固定虚构文字测试文档模型连接';
    }else{
      const media=readMediaSettings(form,target),shared=media.provider==='shared',model=media.model||(target==='vision'&&shared?saved.model:'');
      form.querySelector('#ai-test-destination').textContent=`测试发往：${(shared?saved.baseUrl:media.baseUrl)||'请填写服务地址'} · 模型：${model||'请填写模型名称'}${shared?'（使用已保存的文档服务配置）':''}`;
      form.querySelector('#ai-test-consent-label').textContent=target==='transcription'?'同意发送固定静音示例测试录音接口（仅验证接口受理，不代表实际听写效果）':'同意发送带有“连接测试”文字的固定测试图，验证图片识别接口';
    }
  }
  function updateMediaHints(form,kind) {
    const d=readMediaSettings(form,kind),shared=d.provider==='shared',qwen=d.provider==='qwen',configured=!!saved[`${kind}KeyConfigured`],same=Boolean(urlOrigin(d.baseUrl)&&urlOrigin(d.baseUrl)===urlOrigin(saved[`${kind}BaseUrl`]));
    const summary=form.querySelector(`[data-ai-media-shared="${kind}"]`);summary.hidden=!shared;summary.textContent=`沿用已保存的文档服务：${saved.baseUrl||'尚未配置'}。${saved.keyConfigured?'使用文档服务已保存的密钥。':'文档服务当前未保存密钥。'}此选项要求服务商提供对应能力，DeepSeek 文档模型不提供录音和图片接口。`;
    form.querySelector(`[data-ai-media-independent="${kind}"]`).hidden=shared;
    form.querySelector(`[data-ai-media-region="${kind}"]`).hidden=!qwen;
    form.querySelector(`[data-ai-media-address-hint="${kind}"]`).textContent=qwen?'请以百炼控制台为准。工作空间地址示例：https://工作空间编号.cn-beijing.maas.aliyuncs.com/compatible-mode/v1；请替换为真实地址。':'填写兼容服务的基础地址，不要填写具体的转写或聊天接口路径。';
    form.querySelector(`[data-ai-media-key-hint="${kind}"]`).textContent=configured&&same&&!d.clearApiKey?'本机已保存这个通道的密钥，留空保留；已保存内容不会回显。':configured&&!same?'服务地址已改变，请填写对应服务的密钥。原密钥不会自动发往新地址。':'请单独填写这个通道的密钥，不会复制或改动文档服务的密钥。';
    form.elements[`${kind}ApiKey`].placeholder=configured&&same&&!d.clearApiKey?'留空保留这个通道已保存的密钥':qwen?'粘贴对应地域和工作空间的百炼密钥':'免密本机服务可留空';
    form.querySelector(`[data-ai-media-clear="${kind}"]`).hidden=!configured;
    form.querySelector(`[data-ai-media-limits="${kind}"]`).textContent=kind==='transcription'?(qwen?`${MEDIA_CHANNELS[kind].hint} 每段不超过 5 分钟，Base64 编码后不超过 10 MB。测试仅发送 1 秒静音。`:'兼容接口当前使用单文件转写，最大 20 MiB，不自动分段。请按服务商要求选择模型和音频格式。'):`${MEDIA_CHANNELS[kind].hint}${qwen?'千问图片使用 Base64 传输，建议原图不超过 7 MB，编码后须满足服务商限制。':''}`;
  }
  function clearErrors(form) {
    form.querySelectorAll('.ai-field-error').forEach(el=>el.textContent='');
    form.querySelectorAll('[aria-invalid]').forEach(el=>el.removeAttribute('aria-invalid'));
    form.querySelector('.form-error').textContent='';
  }
  function clearFieldError(form,name) {
    if(name==='clearApiKey')name='apiKey';
    const el=form.querySelector(`#ai-${name}-error`);if(el)el.textContent='';
    form.elements[name]?.removeAttribute('aria-invalid');
    if(name==='model'){form.querySelector('#ai-model-selection-error').textContent='';form.querySelector('#ai-model-choice').removeAttribute('aria-invalid');}
  }
  function setFieldError(form,name,message) {
    const hiddenModel=name==='model'&&form.querySelector('#ai-model-input-field').hidden;
    const el=form.querySelector(hiddenModel?'#ai-model-selection-error':`#ai-${name}-error`);if(el)el.textContent=message;
    (hiddenModel?form.querySelector('#ai-model-choice'):form.elements[name])?.setAttribute('aria-invalid','true');
  }
  async function submit(form) {
    clearErrors(form);
    const currentTarget=target,d=target==='text'?read(form):readMediaSettings(form,target),test=form.dataset.submitMode==='test';
    const hasMediaModel=Boolean(saved.transcriptionModel||saved.visionModel);
    const textValidation=target==='text'?{...d,enabled:d.enabled&&Boolean(d.model||!hasMediaModel)}:null;
    const issues=target==='text'?connectionIssues(textValidation,saved,{testing:test}):mediaConnectionIssues(target,d,saved,test);
    if(test&&!form.elements.consent.checked)issues.consent='请勾选同意发送本页说明的固定测试示例，再保存并测试。';
    if(Object.keys(issues).length){
      for(const [name,message] of Object.entries(issues))setFieldError(form,name,message);
      form.querySelector('.form-error').textContent=issues.consent||'请检查标出的接入信息，尚未保存或发送测试。';
      const name=Object.keys(issues)[0],control=name==='model'&&form.querySelector('#ai-model-input-field').hidden?form.querySelector('#ai-model-choice'):form.elements[name];
      control?.focus();control?.scrollIntoView({block:'nearest'});return;
    }
    const payload=target==='text'?{enabled:d.enabled,baseUrl:d.baseUrl,model:d.model}:{enabled:form.elements.enabled.checked,[`${target}Provider`]:d.provider,[`${target}Model`]:d.model};
    if(target==='text'){
      if(d.apiKey)payload.apiKey=d.apiKey;
      if(d.clearApiKey)payload.clearApiKey=true;
    }else if(d.provider!=='shared'){
      payload[`${target}BaseUrl`]=d.baseUrl;
      if(d.apiKey)payload[`${target}ApiKey`]=d.apiKey;
      if(d.clearApiKey)payload[`clear${target[0].toUpperCase()}${target.slice(1)}ApiKey`]=true;
    }
    await request(form,test?'正在保存并测试…':'正在保存…',async()=>{
      let stage='save';
      try{
        setStatus(form,'pending','正在保存设置…','配置保存在本机，不会发送任务、素材或文档。');
        const result=await saveSettings(payload);saved={...result.settings};
        const keyName=currentTarget==='text'?'apiKey':`${currentTarget}ApiKey`,clearName=currentTarget==='text'?'clearApiKey':`${currentTarget}ClearApiKey`;
        if(currentTarget==='text'||d.provider!=='shared'){form.elements[keyName].value='';form.elements[clearName].checked=false;}
        if(currentTarget==='text'){
          drafts=new Map();
          for(const kind of Object.keys(MEDIA_CHANNELS))if((saved[`${kind}Provider`]||'shared')==='shared')statuses.delete(kind);
        }else for(const key of mediaDrafts.keys())if(key.startsWith(`${currentTarget}:`))mediaDrafts.delete(key);
        updateHints(form);rerender();
        if(!test){setStatus(form,'pending','当前页设置已保存','尚未调用模型。勾选同意项后，可使用“保存并测试”验证当前服务。');return;}
        stage='test';setStatus(form,'pending','正在测试模型连接…',currentTarget==='text'?'正在发送固定虚构文字，请稍候。':`正在发送${MEDIA_CHANNELS[currentTarget].sample}，不读取任务资料。`);
        const response=await testConnection(currentTarget);
        const name=currentTarget==='text'?'文档模型':MEDIA_CHANNELS[currentTarget].name;
        setStatus(form,'success',`${name}连接成功`,response.message||(currentTarget==='transcription'?'接口已受理固定静音测试。实际识别效果请另用短录音核对。':'当前配置已通过测试。'));
      }catch(error){
        setStatus(form,'failed',stage==='test'?'设置已保存，连接测试未通过':'设置未保存',error.message||'请检查接入信息后重试。');
        throw error;
      }
    });
  }
  return {open,submit};
}
