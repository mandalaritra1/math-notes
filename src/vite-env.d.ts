/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Optional: bake a default Google OAuth client ID into the build. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}
