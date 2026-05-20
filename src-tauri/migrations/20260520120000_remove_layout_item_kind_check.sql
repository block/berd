CREATE TABLE layout_items_new (
    layout_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    center_x REAL NOT NULL,
    center_y REAL NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    z_index INTEGER NOT NULL,
    sort_seq INTEGER NOT NULL CHECK (sort_seq >= 1),
    title_override TEXT,
    PRIMARY KEY (layout_id, id),
    UNIQUE (layout_id, kind, target_id)
);

INSERT INTO layout_items_new (
    layout_id,
    id,
    kind,
    target_id,
    center_x,
    center_y,
    width,
    height,
    z_index,
    sort_seq,
    title_override
)
SELECT
    layout_id,
    id,
    kind,
    target_id,
    center_x,
    center_y,
    width,
    height,
    z_index,
    sort_seq,
    title_override
FROM layout_items;

DROP TABLE layout_items;

ALTER TABLE layout_items_new RENAME TO layout_items;

CREATE INDEX layout_items_render_order_idx
ON layout_items (layout_id ASC, z_index ASC, sort_seq ASC, id ASC);
