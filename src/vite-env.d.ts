/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HYDRUS_URL?: string;
  readonly VITE_HYDRUS_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
