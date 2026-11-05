# Root frame d_photos_listing (348:20230) is a 1366×768 viewport frame with clipscontent false, and its content (container 348:20231) runs to 2488px. the compiler gave the root a fixed h of raw 768, so the render stops at y≈768 while the screenshot is 2488 tall. a non-clipping root whose children overflow should take the height of its renderbbox (2496) or of its content, or the conform check should measure against renderbbox. every override that fixes this is refused because it adds a conform error.

Status: needs-triage
Key: root frame d_photos_listing (348:20230) is a 1366×768 viewport frame with clipscontent false, and its content (container 348:20231) runs to 2488px. the compiler gave the root a fixed h of raw 768, so the render stops at y≈768 while the screenshot is 2488 tall. a non-clipping root whose children overflow should take the height of its renderbbox (2496) or of its content, or the conform check should measure against renderbbox. every override that fixes this is refused because it adds a conform error.

Reported by the frame-match agent: what the compiler should have done. Fix it in the pipeline.

## Comments

- run 47817397-73d9-43b1-9429-610e9e400510: Root frame D_Photos_Listing (348:20230) is a 1366×768 viewport frame with clipsContent false, and its content (container 348:20231) runs to 2488px. The compiler gave the root a fixed h of raw 768, so the render stops at y≈768 while the screenshot is 2488 tall. A non-clipping root whose children overflow should take the height of its renderBbox (2496) or of its content, or the conform check should measure against renderBbox. Every override that fixes this is refused because it adds a conform error.
