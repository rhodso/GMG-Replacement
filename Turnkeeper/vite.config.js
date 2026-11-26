import { defineConfig } from "vite";

export default defineConfig({
  base: "/Turnkeeper/",
  server: {
    cors: {
      origin: "https://www.owlbear.rodeo",
    },
  },
});
