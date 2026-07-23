# Snapshot export

Snapshot export is a one-time transfer. It creates or selects a spreadsheet, writes query results, and creates no durable binding or refresh checkpoint.

## Flow

1. Require a saved row-returning query and resolve typed parameters.
2. Ask the user to create or select a spreadsheet.
3. Obtain a short-lived Google access token.
4. Execute the query and stream rows into byte-bounded upload chunks.
5. Write to a new managed data worksheet using RAW values.
6. Apply headers, basic formatting, frozen header, and filter.
7. Report rows, columns, cells, and any conversion warnings.

## Semantics

- Snapshot export never modifies an existing linked binding.
- It may write into a new spreadsheet or a newly created worksheet in an existing spreadsheet.
- No refresh hyperlink, `_ASB_STATE`, binding table row, or refresh history row is created.
- No silent truncation is permitted.
- Failure may delete the partially created worksheet when safe; otherwise it is clearly marked incomplete.

Snapshot export shares the canonical type conversion, quota handling, and streaming upload implementation with linked refreshes.
