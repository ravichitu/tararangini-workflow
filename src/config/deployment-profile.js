function numberEnv(name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(raw)));
}

function stringEnv(name, fallback, allowed = []) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  if (allowed.length && !allowed.includes(value)) return fallback;
  return value;
}

const DEPLOYMENT_PROFILES = {
  lan: {
    request_body_limit_mb: 50,
    customer_upload_limit_mb: 15,
    staff_upload_limit_mb: 10,
    auth_rate_limit_max: 10,
    customer_portal_rate_limit_max: 180,
    target_concurrent_customers: 200,
    attachment_storage_mode: 'inline-db',
    attachment_analysis_mode: 'sync'
  },
  store: {
    request_body_limit_mb: 60,
    customer_upload_limit_mb: 20,
    staff_upload_limit_mb: 15,
    auth_rate_limit_max: 15,
    customer_portal_rate_limit_max: 600,
    target_concurrent_customers: 200,
    attachment_storage_mode: 'filesystem',
    attachment_analysis_mode: 'async'
  },
  public: {
    request_body_limit_mb: 75,
    customer_upload_limit_mb: 20,
    staff_upload_limit_mb: 20,
    auth_rate_limit_max: 20,
    customer_portal_rate_limit_max: 900,
    target_concurrent_customers: 300,
    attachment_storage_mode: 'filesystem',
    attachment_analysis_mode: 'async'
  }
};

const DEPLOYMENT_PROFILE_NAME = stringEnv('TARANGINI_DEPLOYMENT_PROFILE', 'lan', Object.keys(DEPLOYMENT_PROFILES));
const selectedProfile = DEPLOYMENT_PROFILES[DEPLOYMENT_PROFILE_NAME];

const REQUEST_BODY_LIMIT_MB = numberEnv('TARANGINI_REQUEST_BODY_LIMIT_MB', selectedProfile.request_body_limit_mb, 5, 500);
const CUSTOMER_UPLOAD_LIMIT_MB = numberEnv('TARANGINI_CUSTOMER_UPLOAD_LIMIT_MB', selectedProfile.customer_upload_limit_mb, 1, 100);
const STAFF_UPLOAD_LIMIT_MB = numberEnv('TARANGINI_STAFF_UPLOAD_LIMIT_MB', selectedProfile.staff_upload_limit_mb, 1, 100);
const AUTH_RATE_LIMIT_MAX = numberEnv('TARANGINI_AUTH_RATE_LIMIT_MAX', selectedProfile.auth_rate_limit_max, 3, 500);
const CUSTOMER_PORTAL_RATE_LIMIT_MAX = numberEnv(
  'TARANGINI_CUSTOMER_PORTAL_RATE_LIMIT_MAX',
  selectedProfile.customer_portal_rate_limit_max,
  30,
  5000
);
const TARGET_CONCURRENT_CUSTOMERS = numberEnv(
  'TARANGINI_TARGET_CONCURRENT_CUSTOMERS',
  selectedProfile.target_concurrent_customers,
  25,
  2000
);
const ATTACHMENT_STORAGE_MODE = stringEnv(
  'TARANGINI_ATTACHMENT_STORAGE_MODE',
  selectedProfile.attachment_storage_mode,
  ['inline-db', 'filesystem']
);
const ATTACHMENT_ANALYSIS_MODE = stringEnv(
  'TARANGINI_ATTACHMENT_ANALYSIS_MODE',
  selectedProfile.attachment_analysis_mode,
  ['sync', 'async']
);
const ATTACHMENT_RETENTION_DAYS = numberEnv('TARANGINI_ATTACHMENT_RETENTION_DAYS', 7, 0, 3650);

function deploymentProfile() {
  return {
    profile_name: DEPLOYMENT_PROFILE_NAME,
    request_body_limit_mb: REQUEST_BODY_LIMIT_MB,
    customer_upload_limit_mb: CUSTOMER_UPLOAD_LIMIT_MB,
    staff_upload_limit_mb: STAFF_UPLOAD_LIMIT_MB,
    auth_rate_limit_max: AUTH_RATE_LIMIT_MAX,
    customer_portal_rate_limit_max: CUSTOMER_PORTAL_RATE_LIMIT_MAX,
    target_concurrent_customers: TARGET_CONCURRENT_CUSTOMERS,
    attachment_storage_mode: ATTACHMENT_STORAGE_MODE,
    attachment_analysis_mode: ATTACHMENT_ANALYSIS_MODE,
    attachment_retention_days: ATTACHMENT_RETENTION_DAYS,
    channels_ready: {
      desktop: true,
      pwa: true,
      android_pwa: true,
      website_api: true
    }
  };
}

module.exports = {
  DEPLOYMENT_PROFILE_NAME,
  REQUEST_BODY_LIMIT_MB,
  CUSTOMER_UPLOAD_LIMIT_MB,
  STAFF_UPLOAD_LIMIT_MB,
  AUTH_RATE_LIMIT_MAX,
  CUSTOMER_PORTAL_RATE_LIMIT_MAX,
  TARGET_CONCURRENT_CUSTOMERS,
  ATTACHMENT_STORAGE_MODE,
  ATTACHMENT_ANALYSIS_MODE,
  ATTACHMENT_RETENTION_DAYS,
  deploymentProfile
};
