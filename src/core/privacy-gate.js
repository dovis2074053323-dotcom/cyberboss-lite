// The server-side projection of Clawd's AccessibilityPrivacyFilter contract.
//
// Android is the authoritative collection gate. This module is the second,
// source-independent boundary for old/remote Tasker and companion rows before
// they become an observation bundle or a Claude prompt. It deliberately does
// not make proactive decisions; it only removes data categories that are not
// allowed to cross the observation boundary.

const USER_BLOCKED_PACKAGES = new Set(
  String(process.env.CLAWD_PRIVACY_BLOCKED_PACKAGES || "")
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean),
);

const NETWORK_KEY = /(?:^|_)(?:ip|ipv4|ipv6|clientip|client_ip|remoteaddress|remote_addr|forwarded|x_forwarded_for|x_real_ip|cf_connecting_ip|ssid|bssid|mac|tailscale)(?:$|_)/i;
const LOCATION_KEY = /(?:location|latitude|longitude|^lat$|^lng$|^lon$|gps|geofence|geo_zone|address|coordinates?|^city$|place|query_location)/i;
const TRAVEL_KEY = /(?:travel|itinerary|destination|route|station|airport|flight|train|hotel|booking|reservation|ticket|12306|railway|metro|transit|subway)/i;
const HEALTH_KEY = /(?:^|_)(?:health|heart|heart_rate|hr|latest_hr|stress|steps?|sleep|blood|spo2|oxygen|medication|symptom)(?:$|_)/i;
const WEATHER_KEY = /^(?:weather|weather_desc|condition|description|desc|temperature|temp|temp_c|temperature_c|rain|rainfall|precipitation|snow|wind|humidity|weather_updated_at)$/i;
const BATTERY_KEY = /^(?:battery|battery_level|battery_charging|charging|screen_on|screen_active|agent_status|updated_at)$/i;
const PACKAGE_TOKEN = /(?:12306|mobileticket|railway|ctrip|qunar|fliggy|travel|flight|airline|hotel|ticket|station|airport|metro|transit|subway|didi|uber|amap|minimap|baidumap|tencentmap|google\.android\.apps\.maps|bank|netbank|creditcard|alipay|unionpay|wallet|pay|password|keeper|1password|bitwarden|lastpass|authenticator|otp|health|medical|clinic|hospital|wechat|com\.tencent\.mm)/i;
const SENSITIVE_TEXT = /(?:location|latitude|longitude|gps|geofence|coordinates?|address|travel|itinerary|destination|route|station|airport|flight|train|hotel|booking|reservation|ticket|12306|railway|metro|transit|subway|health|medical|clinic|hospital|password|bank|payment|wallet|ssid|bssid|mac|tailscale|forwarded|(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4})/i;
const IP_VALUE = /^(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4})$/i;
const SAFE_COMPANION_SUMMARY = /^(?:social browsing|web browsing|chatting|reading|working|writing|listening to music|taking photos|shopping|watching video|gaming|companion interaction|phone activity|screen off), (?:under \d+m|\d+h(?: \d+m)?|\d+m), (?:active|continuous|intermittent|idle)$/;
const SAFE_COMPANION_INTERACTION_KEYS = new Set([
  "tap", "double_tap", "long_press", "fling", "screenshot", "combo", "companion_interaction",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUserBlockedPackage(value) {
  return typeof value === "string" && USER_BLOCKED_PACKAGES.has(value.trim());
}

function setUserBlockedPackages(packages) {
  USER_BLOCKED_PACKAGES.clear();
  for (const value of Array.isArray(packages) ? packages : []) {
    if (typeof value === "string" && value.trim()) USER_BLOCKED_PACKAGES.add(value.trim());
  }
}

function isSensitivePackage(value) {
  return typeof value === "string" && PACKAGE_TOKEN.test(value.trim());
}

function isNetworkValue(value) {
  return typeof value === "string" && IP_VALUE.test(value.trim());
}

function containsSensitiveText(value) {
  return typeof value === "string" && SENSITIVE_TEXT.test(value);
}

function copySafeScalar(value) {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

function sanitizeStructuredObject(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeStructuredObject).filter((item) => item !== undefined);
  }
  if (!isObject(value)) return copySafeScalar(value);

  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (NETWORK_KEY.test(key) || LOCATION_KEY.test(key) || TRAVEL_KEY.test(key) || HEALTH_KEY.test(key)) continue;
    if (isNetworkValue(raw)) continue;
    const next = sanitizeStructuredObject(raw);
    if (next !== undefined) output[key] = next;
  }
  return output;
}

function sanitizeWeather(value) {
  if (!isObject(value)) return copySafeScalar(value);
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!WEATHER_KEY.test(key) || NETWORK_KEY.test(key) || LOCATION_KEY.test(key) || TRAVEL_KEY.test(key)) continue;
    const next = isObject(raw) ? sanitizeWeather(raw) : copySafeScalar(raw);
    if (next !== undefined) output[key] = next;
  }
  return output;
}

function sanitizeHealthSnapshot(value) {
  if (!isObject(value)) return {};
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (NETWORK_KEY.test(key) || LOCATION_KEY.test(key) || TRAVEL_KEY.test(key)) continue;
    if (BATTERY_KEY.test(key)) {
      const next = copySafeScalar(raw);
      if (next !== undefined) output[key] = next;
      continue;
    }
    if (WEATHER_KEY.test(key)) {
      const next = isObject(raw) ? sanitizeWeather(raw) : copySafeScalar(raw);
      if (next !== undefined) output[key] = next;
    }
  }
  return output;
}

function sanitizePackage(value) {
  if (typeof value !== "string") return undefined;
  const packageName = value.trim();
  if (!packageName || isUserBlockedPackage(packageName) || isSensitivePackage(packageName)) return undefined;
  return packageName;
}

function sanitizeActivitySnapshot(value) {
  if (!isObject(value)) return {};
  const output = {};
  for (const key of ["current_app", "previous_app", "session_start", "updated_at"]) {
    if (!(key in value)) continue;
    if (key === "current_app" || key === "previous_app") {
      const next = sanitizePackage(value[key]);
      if (next !== undefined) output[key] = next;
    } else {
      const next = copySafeScalar(value[key]);
      if (next !== undefined) output[key] = next;
    }
  }
  for (const key of ["app_usage_today", "app_open_count"]) {
    if (!isObject(value[key])) continue;
    const next = {};
    for (const [packageName, count] of Object.entries(value[key])) {
      const safePackage = sanitizePackage(packageName);
      const safeCount = copySafeScalar(count);
      if (safePackage !== undefined && safeCount !== undefined) next[safePackage] = safeCount;
    }
    output[key] = next;
  }
  return output;
}

function sanitizeTaskerSnapshot(value) {
  if (!isObject(value)) return value;
  const output = {};
  const activity = sanitizeActivitySnapshot(value.activity);
  const health = sanitizeHealthSnapshot(value.health);
  if (Object.keys(activity).length > 0) output.activity = activity;
  if (Object.keys(health).length > 0) output.health = health;
  return output;
}

function sanitizeCompanionSummary(value) {
  const summary = typeof value === "string" ? value.trim() : "";
  return SAFE_COMPANION_SUMMARY.test(summary) ? summary : "activity summary unavailable";
}

function sanitizeCompanionInteraction(value) {
  if (!isObject(value)) return {};
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SAFE_COMPANION_INTERACTION_KEYS.has(key)) continue;
    const number = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : null;
    if (number === null) continue;
    output[key] = Math.max(0, Math.min(number, 9999));
  }
  return output;
}

function sanitizeCompanionContext(value) {
  if (!isObject(value)) return null;
  const packageName = typeof value.package === "string" ? value.package.trim() : "";
  if (isUserBlockedPackage(packageName) || isSensitivePackage(packageName)) return null;

  const title = typeof value.title === "string" ? value.title : undefined;
  const url = typeof value.url === "string" ? value.url : undefined;
  if (containsSensitiveText(`${title || ""} ${url || ""}`)) return null;

  const output = {};
  if (packageName) output.package = packageName;
  if (typeof value.activity === "string" && !LOCATION_KEY.test(value.activity)) output.activity = value.activity;
  // WeChat's existing no-text rule is also enforced for old rows that were
  // written before the Android gate was tightened.
  if (packageName === "com.tencent.mm") return Object.keys(output).length ? output : null;
  if (title !== undefined) output.title = title;
  if (url !== undefined) output.url = url;
  return Object.keys(output).length ? output : null;
}

function sanitizeCompanionSegments(value) {
  if (!Array.isArray(value)) return value;
  return value.map((segment) => {
    if (!isObject(segment)) return null;
    const output = {};
    for (const key of ["start_ts", "end_ts", "screen_active"]) {
      const next = copySafeScalar(segment[key]);
      if (next !== undefined) output[key] = next;
    }
    output.summary = sanitizeCompanionSummary(segment.summary);
    const contexts = Array.isArray(segment.contexts)
      ? segment.contexts.map(sanitizeCompanionContext).filter(Boolean)
      : [];
    output.contexts = contexts;
    output.interaction = sanitizeCompanionInteraction(segment.interaction || {});
    return output;
  }).filter(Boolean);
}

function sanitizeClawdContext(value) {
  if (!isObject(value)) return { filtered: true, filterReason: "invalid_context" };
  if (value.filtered === true) {
    return {
      filtered: true,
      filterReason: typeof value.filterReason === "string" ? value.filterReason : "filtered",
    };
  }
  const packageName = typeof value.package === "string" ? value.package.trim() : "";
  const title = typeof value.title === "string" ? value.title : undefined;
  const url = typeof value.url === "string" ? value.url : undefined;
  if (isUserBlockedPackage(packageName)) return { filtered: true, filterReason: "user_blocked_app" };
  const activity = typeof value.activity === "string" ? value.activity : undefined;
  if (isSensitivePackage(packageName) || containsSensitiveText(`${activity || ""} ${title || ""} ${url || ""}`)) {
    return { filtered: true, filterReason: "sensitive_context" };
  }
  const output = { filtered: false };
  if (packageName) output.package = packageName;
  if (activity !== undefined) output.activity = activity;
  if (title !== undefined) output.title = title;
  if (url !== undefined) output.url = url;
  return output;
}

module.exports = {
  isSensitivePackage,
  isUserBlockedPackage,
  setUserBlockedPackages,
  sanitizeClawdContext,
  sanitizeCompanionSegments,
  sanitizeCompanionSummary,
  sanitizeCompanionInteraction,
  sanitizeHealthSnapshot,
  sanitizeStructuredObject,
  sanitizeTaskerSnapshot,
  sanitizeWeather,
};
