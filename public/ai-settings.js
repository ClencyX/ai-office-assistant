import {MODEL_PROVIDERS,DEEPSEEK_MODELS,urlOrigin,isLocalService,inferProvider,connectionIssues} from './model-providers.js';

// 设置窗口中的草稿和测试状态只存在于当前窗口，不将密钥存入页面持久化存储。
export function createModelSettings(ui) {
  const {esc,openDrawer,action,request,getSettings,saveSettings,testConnection,rerender}=ui;
  let saved={},provider='custom',drafts=new Map();
  const field=(label,name,value,hint,extra='')=>`<div class="field"><label for="ai-${name}">${label}</label><input id="ai-${name}" name="${name}" value="${esc(value||'')}" ${extra}><span class="hint" id="ai-${name}-hint">${hint}</span><span class="ai-field-error" id="ai-${name}-error"></span></div>`;
  const read=form=>({enabled:form.elements.enabled.checked,baseUrl:form.elements.baseUrl.value.trim(),model:form.elements.model.value.trim(),transcriptionModel:form.elements.transcriptionModel.value.trim(),visionModel:form.elements.visionModel.value.trim(),apiKey:form.elements.apiKey.value.trim(),clearApiKey:form.elements.clearApiKey.checked});
  function open() {
    saved={...getSettings()};provider=inferProvider(saved.baseUrl);drafts=new Map();
    const s={enabled:!!saved.enabled,baseUrl:saved.baseUrl||'',model:saved.model||'',transcriptionModel:saved.transcriptionModel||'',visionModel:saved.visionModel||'',apiKey:'',clearApiKey:false};
    openDrawer('配置 AI 模型',`<form id="ai-settings-form" novalidate><p class="ai-settings-intro">选好服务，填写接入信息，保存后验证连接。</p><div class="form-error" role="alert"></div><section class="ai-settings-step"><div class="ai-step-heading"><span>1</span><h3>选择模型服务</h3></div><div class="ai-provider-options" role="group" aria-label="选择模型服务">${MODEL_PROVIDERS.map(p=>`<label class="ai-provider ${provider===p.id?'is-selected':''}"><input type="radio" name="provider" value="${p.id}" ${provider===p.id?'checked':''}><span><strong>${p.name}</strong><small>${p.description}</small></span></label>`).join('')}</div><p class="ai-settings-small">切换服务会保留各自本次填写的内容；点击保存后才会生效。</p></section><section class="ai-settings-step"><div class="ai-step-heading"><span>2</span><h3>填写接入信息</h3><button type="button" class="ai-settings-link" id="ai-use-defaults">使用推荐参数</button></div><div id="ai-provider-help" class="ai-provider-help"></div><div class="ai-form-stack">${field('模型服务地址','baseUrl',s.baseUrl,'','type="url" maxlength="2000" spellcheck="false" autocomplete="off" aria-describedby="ai-baseUrl-hint ai-baseUrl-error"')}<div id="ai-model-select-field" class="field"><label for="ai-model-choice">文档模型</label><select id="ai-model-choice">${DEEPSEEK_MODELS.map(m=>`<option value="${m.id}">${m.name} · ${m.id}</option>`).join('')}<option value="custom">填写其他模型名称</option></select><span class="hint">日常整理会议纪要、起草材料，可先选择推荐模型。</span></div><div id="ai-model-input-field">${field('完整模型名称','model',s.model,'','maxlength="200" spellcheck="false" autocomplete="off" aria-describedby="ai-model-hint ai-model-error"')}</div><div id="ai-model-selection-error" class="ai-field-error"></div><div class="field"><div class="ai-field-label"><label for="ai-apiKey" id="ai-key-label">接口密钥</label><a id="ai-key-link" href="https://platform.deepseek.com/" target="_blank" rel="noopener noreferrer">前往 DeepSeek 获取密钥 ↗</a></div><div class="ai-key-input"><input id="ai-apiKey" name="apiKey" type="password" autocomplete="new-password" maxlength="2000" spellcheck="false" aria-describedby="ai-key-hint ai-apiKey-error"><button type="button" id="ai-key-visibility" aria-label="显示本次输入的密钥" aria-pressed="false">显示</button></div><span class="hint" id="ai-key-hint"></span><span class="ai-field-error" id="ai-apiKey-error"></span><label class="ai-check ai-clear-key" id="ai-clear-key-row"><input type="checkbox" name="clearApiKey"><span id="ai-clear-key-label">保存时清除原密钥</span></label></div><details class="ai-settings-advanced"><summary>高级选项：录音转写与图片识别</summary><div class="ai-form-stack"><p class="ai-settings-small">以下功能与文档模型共用服务地址和密钥，需服务商提供对应接口或能力。仅填写模型名称不能开通功能。</p>${field('录音转写模型名称（选填）','transcriptionModel',s.transcriptionModel,'请按服务商说明填写兼容的录音转写模型。DeepSeek 文档模型不提供录音转写。','maxlength="200" spellcheck="false" placeholder="未使用录音功能可留空"')}${field('图片识别模型（选填）','visionModel',s.visionModel,'请填写支持图片输入的兼容模型；留空使用文档模型。仅识别文字，不保留图片排版。','maxlength="200" spellcheck="false" placeholder="留空使用文档模型" aria-describedby="ai-visionModel-hint ai-visionModel-error"')}<p class="ai-settings-small">DeepSeek 文档模型不支持图片输入时，可在任务中粘贴人工识别的文字，或改用提供图片输入能力的兼容服务。</p></div></details><label class="ai-check"><input name="enabled" type="checkbox" ${s.enabled?'checked':''}><span>启用 AI 文档辅助</span></label></div></section><section class="ai-settings-step ai-settings-test"><div class="ai-step-heading"><span>3</span><h3>保存并验证连接</h3></div><div class="ai-connection-status" id="ai-connection-status" role="status" aria-live="polite"><strong>尚未测试连接</strong><p>保存仅将配置写入本机，连接是否可用需通过测试确认。</p></div><p class="ai-settings-small" id="ai-test-destination"></p><label class="ai-check"><input type="checkbox" name="consent"><span>同意发送一段固定虚构文字测试连接</span></label><p class="ai-settings-small">测试不读取任务、素材或文档，服务商可能按请求计费。文档生成、录音转写和图片识别会另行确认。</p></section></form>`,`${action('close','关闭','button')}<button type="submit" form="ai-settings-form" class="button" value="save">保存设置</button><button type="submit" form="ai-settings-form" class="button primary" value="test">保存并测试</button>`);
    const form=document.querySelector('#ai-settings-form');
    form.closest('.drawer').classList.add('ai-settings-dialog');
    form.addEventListener('submit',e=>{form.dataset.submitMode=e.submitter?.value||'save';});
    form.addEventListener('input',e=>{
      if(['provider','consent'].includes(e.target.name))return;
      if(['baseUrl','model','apiKey','transcriptionModel','visionModel'].includes(e.target.name))form.elements.consent.checked=false;
      markChanged(form);updateHints(form);clearFieldError(form,e.target.name);
    });
    form.addEventListener('change',e=>{
      if(e.target.name==='provider'){switchProvider(form,e.target.value);return;}
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
    syncModelChoice(form);updateHints(form);
    if(provider==='deepseek'&&s.model==='deepseek')setFieldError(form,'model','deepseek 是服务名称，请选择完整模型编号。');
  }
  function syncModelChoice(form) {
    form.querySelector('#ai-model-choice').value=DEEPSEEK_MODELS.some(m=>m.id===form.elements.model.value)?form.elements.model.value:'custom';
  }
  function switchProvider(form,next) {
    drafts.set(provider,read(form));provider=next;
    const p=MODEL_PROVIDERS.find(p=>p.id===provider);
    const d=drafts.get(provider)||{...read(form),baseUrl:p.baseUrl,model:p.model,apiKey:'',transcriptionModel:'',visionModel:'',clearApiKey:provider==='ollama'&&saved.keyConfigured&&urlOrigin(saved.baseUrl)!==urlOrigin(p.baseUrl)};
    for(const name of ['baseUrl','model','apiKey','transcriptionModel','visionModel'])form.elements[name].value=d[name]||'';
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
    form.querySelector('#ai-test-destination').textContent=`测试发往：${d.baseUrl||'请填写服务地址'} · 模型：${d.model||'请选择或填写模型'}`;
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
    const d=read(form),test=form.dataset.submitMode==='test';
    const issues=connectionIssues(d,saved,{testing:test});
    if(test&&!form.elements.consent.checked)issues.consent='请勾选同意发送固定虚构文字，再保存并测试。';
    if(Object.keys(issues).length){
      for(const [name,message] of Object.entries(issues))setFieldError(form,name,message);
      form.querySelector('.form-error').textContent=issues.consent||'请检查标出的接入信息，尚未保存或发送测试。';
      const name=Object.keys(issues)[0],control=name==='model'&&form.querySelector('#ai-model-input-field').hidden?form.querySelector('#ai-model-choice'):form.elements[name];
      control?.focus();control?.scrollIntoView({block:'nearest'});return;
    }
    const payload={enabled:d.enabled,baseUrl:d.baseUrl,model:d.model,transcriptionModel:d.transcriptionModel,visionModel:d.visionModel};
    if(d.apiKey)payload.apiKey=d.apiKey;
    if(d.clearApiKey)payload.clearApiKey=true;
    await request(form,test?'正在保存并测试…':'正在保存…',async()=>{
      let stage='save';
      try{
        setStatus(form,'pending','正在保存设置…','配置保存在本机，不会发送任务、素材或文档。');
        const result=await saveSettings(payload);saved={...result.settings};
        form.elements.apiKey.value='';form.elements.clearApiKey.checked=false;drafts=new Map();updateHints(form);rerender();
        if(!test){setStatus(form,'pending',saved.enabled?'设置已保存，尚未测试':'设置已保存，AI 文档辅助已停用',saved.enabled?'可勾选下方同意项，再点击“保存并测试”验证连接。':'启用时补全接入信息，再保存并测试连接。');return;}
        stage='test';setStatus(form,'pending','正在测试模型连接…','正在发送固定虚构文字，请稍候。');
        const response=await testConnection();
        setStatus(form,'success',saved.enabled?'连接成功':'连接成功，AI 文档辅助仍停用',saved.enabled?(response.message||'当前配置已通过测试，可以返回文档工作区起草文档。'):'模型已通过测试。需要起草文档时，请勾选“启用 AI 文档辅助”并保存。');
      }catch(error){
        setStatus(form,'failed',stage==='test'?'设置已保存，连接测试未通过':'设置未保存',error.message||'请检查接入信息后重试。');
        throw error;
      }
    });
  }
  return {open,submit};
}
