# Text content that contains a carriage return was carried over as a line break, even though figma draws it on one line (lines: 1, width_and_height). in i348:20276;13131:56594 ('terms and conditions\r | privacy and policy') this split the link onto two lines and made the footer (348:20276) 21px too tall. normalise '\r' when figma reports a single line.

Status: needs-triage
Key: text content that contains a carriage return was carried over as a line break, even though figma draws it on one line (lines: 1, width_and_height). in i348:20276;13131:56594 ('terms and conditions\r | privacy and policy') this split the link onto two lines and made the footer (348:20276) 21px too tall. normalise '\r' when figma reports a single line.

Reported by the frame-match agent: what the compiler should have done. Fix it in the pipeline.

## Comments

- run 21ca578b-e080-40e0-a222-d81013ea8faa: Text content that contains a carriage return was carried over as a line break, even though Figma draws it on one line (lines: 1, WIDTH_AND_HEIGHT). In I348:20276;13131:56594 ('Terms and Conditions\r | Privacy and Policy') this split the link onto two lines and made the Footer (348:20276) 21px too tall. Normalise '\r' when Figma reports a single line.
