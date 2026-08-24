const PREFIX = 'haitong-mobile-';

const defaults = {
  seaAreaId: '',
  seaAreaName: '全域态势',
  dataSaver: false,
  reducedMotion: false,
};

export function getPreference(name) {
  const fallback = defaults[name];
  const raw = localStorage.getItem(`${PREFIX}${name}`);
  if (raw == null) return fallback;
  if (typeof fallback === 'boolean') return raw === 'true';
  return raw;
}

export function setPreference(name, value) {
  localStorage.setItem(`${PREFIX}${name}`, String(value));
  applyPreferences();
}

export function getSelectedSeaArea() {
  const id = getPreference('seaAreaId');
  return {
    id: id ? Number(id) : null,
    name: getPreference('seaAreaName'),
  };
}

export function setSelectedSeaArea(area) {
  setPreference('seaAreaId', area?.id ?? '');
  setPreference('seaAreaName', area?.name || '全域态势');
}

export function applyPreferences() {
  document.documentElement.classList.toggle('data-saver', getPreference('dataSaver'));
  document.documentElement.classList.toggle('reduce-motion', getPreference('reducedMotion'));
}

export function clearMobileCache() {
  const preserve = new Set([
    'aquarise-api-base',
    'aquarise-token',
    `${PREFIX}seaAreaId`,
    `${PREFIX}seaAreaName`,
    `${PREFIX}dataSaver`,
    `${PREFIX}reducedMotion`,
  ]);
  for (const key of Object.keys(localStorage)) {
    if (!preserve.has(key)) localStorage.removeItem(key);
  }
  sessionStorage.clear();
}
