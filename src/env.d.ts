/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module "leaflet/dist/leaflet.css";
declare module "*.png";
declare module "*.svg";
declare module "*.jpg";
declare module "*.jpeg";
declare module "*.gif";
declare module "*.mjs?url";
