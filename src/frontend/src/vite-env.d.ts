/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_MODE?: 'mock' | 'live';
  readonly VITE_DH_APP_ID?: string;
  readonly VITE_DH_APP_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
