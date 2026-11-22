const CAPABILITY_RULES = {
  view_menu: ['guest', 'user', 'admin'],
  view_help: ['guest', 'user', 'admin'],
  view_guide: ['guest', 'user', 'admin'],
  view_sms_menu: ['guest', 'user', 'admin'],
  view_email_menu: ['guest', 'user', 'admin'],
  view_calllog_menu: ['guest', 'user', 'admin'],
  call: ['user', 'admin'],
  calllog_view: ['user', 'admin'],
  sms_send: ['user', 'admin'],
  sms_status: ['user', 'admin'],
  sms_schedule: ['user', 'admin'],
  email_send: ['user', 'admin'],
  email_status: ['user', 'admin'],
  health: ['user', 'admin'],
  bulk_sms: ['admin'],
  bulk_email: ['admin'],
  sms_admin: ['admin'],
  email_templates: ['admin'],
  email_history: ['admin'],
  scripts_manage: ['admin'],
  persona_manage: ['admin'],
  provider_manage: ['admin'],
  users_manage: ['admin'],
  status_admin: ['admin'],
  dlq_manage: ['admin'],
  caller_flags_manage: ['admin'],
  admin_panel: ['admin'],
};

const COMMAND_CAPABILITIES = {
  help: 'view_help',
  guide: 'view_guide',
  menu: 'view_menu',
  call: 'call',
  calllog: 'view_calllog_menu',
  sms: 'view_sms_menu',
  schedulesms: 'view_sms_menu',
  smsstatus: 'sms_status',
  recentsms: 'sms_admin',
  smsconversation: 'sms_admin',
  smsstats: 'sms_admin',
  email: 'view_email_menu',
  emailstatus: 'email_status',
  smssender: 'bulk_sms',
  mailer: 'bulk_email',
  scripts: 'scripts_manage',
  persona: 'persona_manage',
  provider: 'provider_manage',
  users: 'users_manage',
  callerflags: 'caller_flags_manage',
  admin: 'admin_panel',
  status: 'status_admin',
  callbacks: 'status_admin',
  reviewcases: 'status_admin',
  domainstats: 'status_admin',
  health: 'health',
  ping: 'health',
};

const ACTION_CAPABILITIES = [
  { match: (action) => action === 'HELP', cap: 'view_help' },
  { match: (action) => action === 'GUIDE', cap: 'view_guide' },
  { match: (action) => action === 'MENU', cap: 'view_menu' },
  { match: (action) => action === 'HEALTH', cap: 'health' },
  { match: (action) => action === 'STATUS', cap: 'status_admin' },
  { match: (action) => action === 'SPEKO_USAGE', cap: 'status_admin' },
  { match: (action) => action === 'SPEKO_METRICS', cap: 'status_admin' },
  { match: (action) => action.startsWith('DLQ_RECONCILE:'), cap: 'dlq_manage' },
  { match: (action) => action === 'CALL', cap: 'call' },
  { match: (action) => action === 'CALLLOG', cap: 'view_calllog_menu' },
  { match: (action) => ['CALLLOG_RECENT', 'CALLLOG_SEARCH', 'CALLLOG_DETAILS', 'CALLLOG_EVENTS'].includes(action), cap: 'calllog_view' },
  { match: (action) => action === 'SMS', cap: 'view_sms_menu' },
  { match: (action) => action === 'EMAIL', cap: 'view_email_menu' },
  { match: (action) => ['SMS_SEND', 'SMS_SCHEDULE'].includes(action), cap: 'sms_send' },
  { match: (action) => action === 'SMS_STATUS', cap: 'sms_status' },
  { match: (action) => ['SMS_CONVO', 'SMS_RECENT', 'SMS_STATS', 'RECENT_SMS'].includes(action), cap: 'sms_admin' },
  { match: (action) => action === 'EMAIL_SEND', cap: 'email_send' },
  { match: (action) => action === 'EMAIL_STATUS', cap: 'email_status' },
  { match: (action) => action === 'EMAIL_TEMPLATES', cap: 'email_templates' },
  { match: (action) => action === 'EMAIL_HISTORY', cap: 'email_history' },
  { match: (action) => action === 'BULK_SMS', cap: 'bulk_sms' },
  { match: (action) => action === 'BULK_EMAIL', cap: 'bulk_email' },
  { match: (action) => action.startsWith('BULK_SMS_'), cap: 'bulk_sms' },
  { match: (action) => action.startsWith('BULK_EMAIL_'), cap: 'bulk_email' },
  { match: (action) => action === 'SCRIPTS', cap: 'scripts_manage' },
  { match: (action) => action === 'ADMIN_PANEL', cap: 'admin_panel' },
  { match: (action) => action === 'PERSONA', cap: 'persona_manage' },
  { match: (action) => action === 'PROVIDER_STATUS', cap: 'provider_manage' },
  { match: (action) => action.startsWith('PROVIDER_SET:'), cap: 'provider_manage' },
  { match: (action) => action.startsWith('PROVIDER_CONFIRM:'), cap: 'provider_manage' },
  { match: (action) => action.startsWith('PROVIDER_APPLY:'), cap: 'provider_manage' },
  { match: (action) => ['USERS', 'USERS_LIST', 'ADDUSER', 'PROMOTE', 'REMOVE'].includes(action), cap: 'users_manage' },
  { match: (action) => action.startsWith('USERS_PAGE:'), cap: 'users_manage' },
  { match: (action) => action.startsWith('SMS_RECENT_PAGE:'), cap: 'sms_admin' },
  { match: (action) => action.startsWith('BULK_EMAIL_PAGE:'), cap: 'bulk_email' },
  { match: (action) => ['CALLER_FLAGS', 'CALLER_FLAGS_LIST', 'CALLER_FLAGS_ALLOW', 'CALLER_FLAGS_BLOCK', 'CALLER_FLAGS_SPAM'].includes(action), cap: 'caller_flags_manage' },
  { match: (action) => action.startsWith('CALL_DETAILS:'), cap: 'calllog_view' },
  { match: (action) => action.startsWith('EMAIL_STATUS:'), cap: 'email_status' },
  { match: (action) => action.startsWith('EMAIL_TIMELINE:'), cap: 'email_status' },
  { match: (action) => action.startsWith('EMAIL_BULK:'), cap: 'bulk_email' },
  { match: (action) => action.startsWith('lc:'), cap: 'calllog_view' },
];

function getCapabilityForCommand(command = '') {
  return COMMAND_CAPABILITIES[String(command || '').toLowerCase()] || null;
}

function getCapabilityForAction(action = '') {
  const raw = String(action || '');
  for (const entry of ACTION_CAPABILITIES) {
    if (entry.match(raw)) return entry.cap;
  }
  return null;
}

function isRoleAllowed(role, capability) {
  if (!capability) return true;
  const allowed = CAPABILITY_RULES[capability];
  if (!Array.isArray(allowed)) return true;
  return allowed.includes(role);
}

module.exports = {
  getCapabilityForCommand,
  getCapabilityForAction,
  isRoleAllowed,
};
