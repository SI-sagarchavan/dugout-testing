# A frame with a fixed height but padding larger than that height allows (i348:20277;13744:72929, h 32 with py 25) was compiled with the raw padding, so the box grew. with a fixed height the vertical padding should be clamped so the content fits the ir height.

Status: needs-triage
Key: a frame with a fixed height but padding larger than that height allows (i348:20277;13744:72929, h 32 with py 25) was compiled with the raw padding, so the box grew. with a fixed height the vertical padding should be clamped so the content fits the ir height.

Reported by the frame-match agent: what the compiler should have done. Fix it in the pipeline.

## Comments

- run 21ca578b-e080-40e0-a222-d81013ea8faa: A frame with a fixed height but padding larger than that height allows (I348:20277;13744:72929, h 32 with py 25) was compiled with the raw padding, so the box grew. With a fixed height the vertical padding should be clamped so the content fits the IR height.
