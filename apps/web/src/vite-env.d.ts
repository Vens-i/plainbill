/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AG_GRID_LICENSE_KEY?: string;
  readonly VITE_AG_STUDIO_LICENSE_KEY?: string;
  readonly VITE_PAYPAL_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
