import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Baby Health", short_name: "Baby Health", description: "A calm, private health record for each of your babies.",
    start_url: "/home", scope: "/", display: "standalone", orientation: "portrait", background_color: "#FBF7F1", theme_color: "#FBF7F1", lang: "en-IN", categories: ["health", "medical", "lifestyle"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [{ name: "Add feeding", url: "/home?log=feed" }, { name: "Timeline", url: "/timeline" }],
  };
}
