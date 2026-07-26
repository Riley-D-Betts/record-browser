/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope Public
 *
 * The front end for the schema export: start the job, watch it, download the file, or
 * push it straight at the catalog.
 *
 * Deliberately small. Everything expensive lives in mr_schema_export.js because a
 * Suitelet's 1,000 usage units cannot enumerate ~200 record types (roughly 1,250 units
 * before custom records). What is left here costs almost nothing: submitting a task,
 * reading its status, and streaming a file that already exists.
 *
 * Actions, all on GET except the push:
 *   (none)         the form
 *   ?action=start  submit the Map/Reduce task, redirect back with its id
 *   ?action=status &task=<id>   JSON progress
 *   ?action=download &file=<id> stream the CSV
 *   ?action=push   &file=<id>   POST it to the catalog
 *   ?debug=1       dump the raw custom-field metadata alongside everything else
 */
define([
  'N/task',
  'N/file',
  'N/https',
  'N/log',
  'N/runtime',
  'N/url',
  './lib_customfield_query',
], function (task, file, https, log, runtime, url, customFields) {
  var MAP_REDUCE_SCRIPT_ID = 'customscript_trb_schema_export'
  var MAP_REDUCE_DEPLOYMENT_ID = 'customdeploy_trb_schema_export'

  function onRequest(context) {
    var params = context.request.parameters || {}
    var action = params.action || ''

    try {
      if (action === 'start') return start(context, params)
      if (action === 'status') return status(context, params)
      if (action === 'download') return download(context, params)
      if (action === 'push') return push(context, params)
      if (params.debug === '1') return debugDump(context)
      return form(context, params)
    } catch (e) {
      log.error({ title: 'Schema export Suitelet failed', details: e })
      json(context, 500, { error: e && e.message ? e.message : String(e) })
    }
  }

  function json(context, code, body) {
    context.response.setHeader({ name: 'Content-Type', value: 'application/json' })
    if (code !== 200) context.response.setHeader({ name: 'X-Status', value: String(code) })
    context.response.write(JSON.stringify(body, null, 2))
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * `submit()` throws if a deployment of the script is already running, which is the
   * common case when somebody clicks twice. Reporting that as "already running" beats
   * a stack trace, because the answer is to wait rather than to do anything.
   */
  function start(context, params) {
    var scope = params.scope || 'all'

    var mrTask = task.create({ taskType: task.TaskType.MAP_REDUCE })
    mrTask.scriptId = MAP_REDUCE_SCRIPT_ID
    mrTask.deploymentId = MAP_REDUCE_DEPLOYMENT_ID
    mrTask.params = { custscript_trb_scope: scope }

    try {
      var taskId = mrTask.submit()
      json(context, 200, { taskId: taskId, scope: scope })
    } catch (e) {
      var message = e && e.message ? e.message : String(e)
      var busy = /NO_DEPLOYMENTS_AVAILABLE|already/i.test(message)
      json(context, busy ? 409 : 500, {
        error: busy
          ? 'An export is already running. Wait for it to finish, then start another.'
          : message,
      })
    }
  }

  function status(context, params) {
    if (!params.task) return json(context, 400, { error: 'No task id' })
    var summary = task.checkStatus({ taskId: params.task })
    json(context, 200, {
      taskId: params.task,
      status: summary.status,
      // Only present once the job is past its input stage; absent is normal early on.
      pending: summary.getPendingMapCount ? summary.getPendingMapCount() : null,
      complete: summary.status === task.TaskStatus.COMPLETE,
    })
  }

  /**
   * `response.writeFile` streams from the File Cabinet rather than loading the
   * contents into script memory, which matters: a full schema export runs to several
   * megabytes and reading it into a string to write it back out is how a Suitelet hits
   * its memory ceiling on exactly the accounts that most need the export.
   */
  function download(context, params) {
    if (!params.file) return json(context, 400, { error: 'No file id' })
    var handle = file.load({ id: params.file })
    context.response.writeFile({ file: handle, isInline: false })
  }

  /**
   * Push the file at the catalog's CSV import endpoint.
   *
   * The catalog authenticates with a session cookie, so this needs a token it will
   * accept. Rather than guess at that, the URL and any header come from script
   * parameters — an account that would rather download and upload by hand simply does
   * not set them.
   */
  function push(context, params) {
    if (!params.file) return json(context, 400, { error: 'No file id' })

    var endpoint = scriptParam('custscript_trb_endpoint', '')
    if (!endpoint) {
      return json(context, 400, {
        error:
          'No catalog endpoint configured. Set custscript_trb_endpoint on the Suitelet deployment, or use Download instead.',
      })
    }

    var handle = file.load({ id: params.file })
    var headers = { 'Content-Type': 'text/csv' }
    var token = scriptParam('custscript_trb_token', '')
    if (token) headers.Authorization = 'Bearer ' + token

    var response = https.post({
      url: endpoint,
      body: handle.getContents(),
      headers: headers,
    })

    json(context, 200, {
      pushed: true,
      endpoint: endpoint,
      responseCode: response.code,
      // Truncated: the catalog replies with a per-row preview that can be very large,
      // and this is a confirmation screen, not a log.
      body: String(response.body || '').slice(0, 2000),
    })
  }

  /**
   * Raw metadata, unmapped.
   *
   * Two things could not be settled without a real account: whether a custom-field
   * query returns the uppercase type code or a numeric list id, and what the
   * `appliesto*` columns are actually called. This dumps what this account returns so
   * one run answers both, instead of a guess being baked in and quietly mis-typing
   * every custom field.
   */
  function debugDump(context) {
    var fields = customFields.readCustomFields()
    var lists = customFields.readCustomListValues()
    var types = customFields.readCustomRecordTypes()

    var recordKeys = []
    for (var key in fields.byRecord) {
      if (Object.prototype.hasOwnProperty.call(fields.byRecord, key)) recordKeys.push(key)
    }

    json(context, 200, {
      tables: fields.diagnostics.tables,
      rawSample: fields.diagnostics.rawSample,
      recordKeysFound: recordKeys.slice(0, 50),
      customRecordTypes: types.rows.length,
      customRecordTypesError: types.error,
      customListsError: lists.error,
    })
  }

  // -------------------------------------------------------------------------
  // The form
  // -------------------------------------------------------------------------

  function form(context, params) {
    var self = url.resolveScript({
      scriptId: runtime.getCurrentScript().id,
      deploymentId: runtime.getCurrentScript().deploymentId,
    })

    context.response.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' })
    context.response.write(
      [
        '<!doctype html><meta charset="utf-8">',
        '<title>Schema export</title>',
        '<style>',
        'body{font:14px/1.5 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem}',
        'h1{font-size:1.25rem}code{background:#f4f4f5;padding:.1rem .3rem;border-radius:3px}',
        'button{font:inherit;padding:.4rem .8rem;margin-right:.5rem}',
        '#out{background:#f4f4f5;padding:.75rem;border-radius:4px;white-space:pre-wrap;margin-top:1rem}',
        '</style>',
        '<h1>Schema export</h1>',
        '<p>Writes a CSV the Technical Records Browser imports directly. ',
        'Large accounts produce several numbered files, split so a record type never ',
        'straddles two.</p>',
        '<p><label>Scope <select id="scope">',
        '<option value="all">Everything</option>',
        '<option value="standard">Standard record types only</option>',
        '<option value="custom">Custom record types only</option>',
        '</select></label></p>',
        '<p><button id="go">Start export</button>',
        '<a href="' + self + '&debug=1"><button type="button">Dump raw metadata</button></a></p>',
        '<div id="out">Idle.</div>',
        '<script>',
        'var base=' + JSON.stringify(self) + ';',
        'var out=document.getElementById("out");',
        'document.getElementById("go").onclick=function(){',
        '  out.textContent="Starting…";',
        '  fetch(base+"&action=start&scope="+document.getElementById("scope").value)',
        '    .then(function(r){return r.json()}).then(function(d){',
        '      if(d.error){out.textContent=d.error;return}',
        '      poll(d.taskId)})};',
        'function poll(id){',
        '  fetch(base+"&action=status&task="+id).then(function(r){return r.json()})',
        '    .then(function(d){',
        '      out.textContent="Task "+id+" — "+d.status+(d.pending!=null?" ("+d.pending+" record types left)":"");',
        '      if(!d.complete){setTimeout(function(){poll(id)},5000);return}',
        '      out.textContent="Done. The files are in the File Cabinet folder configured on the deployment ("',
        '        +"look for record-browser-export*.csv), and the script log lists any field types that "',
        '        +"could not be mapped."})}',
        '</script>',
      ].join('\n'),
    )
  }

  function scriptParam(name, fallback) {
    try {
      var value = runtime.getCurrentScript().getParameter({ name: name })
      return value === null || value === undefined || value === '' ? fallback : value
    } catch (e) {
      return fallback
    }
  }

  return { onRequest: onRequest }
})
