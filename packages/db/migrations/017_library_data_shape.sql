-- A section's data as its shape (`.scratch/section-library/issues/16-data-shape.md`): the fields it
-- shows and their types, and its lists with how many items the design draws, read from the binding
-- plan of the latest preview that bound it. Never a value. Shared with the section: field names and
-- types are what another tenant fills the design by.
alter table library_sections add column data_shape jsonb;
