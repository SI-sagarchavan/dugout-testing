import type { ReactNode } from "react";
import { FONT_FACE_CSS } from "@fanos/renderer";
// import "@fanos/renderer/styles.css";

export const metadata = {
  title: "FanOS preview",
};

/** Next serves `public/` at `/`, so font URLs drop the `/public` prefix. */
const FONT_CSS_FOR_NEXT = FONT_FACE_CSS.replaceAll("/public/fonts/", "/fonts/");

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preload"
          href="/fonts/bakbak-one-400.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/montserrat-400.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/montserrat-500.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/montserrat-700.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <style dangerouslySetInnerHTML={{ __html: FONT_CSS_FOR_NEXT }} />
      </head>
      {/* Each page paints its own background: a preview takes the Send's. */}
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
