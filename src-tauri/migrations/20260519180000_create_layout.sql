CREATE TABLE layout_state (
    layout_id TEXT PRIMARY KEY,
    item_revision INTEGER NOT NULL DEFAULT 0 CHECK (item_revision >= 0),
    camera_revision INTEGER NOT NULL DEFAULT 0 CHECK (camera_revision >= 0),
    camera_center_x REAL NOT NULL DEFAULT 0,
    camera_center_y REAL NOT NULL DEFAULT 0,
    zoom_bps INTEGER NOT NULL DEFAULT 10000,
    next_sort_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_sort_seq >= 1)
);

-- V1 supports only the 'home' layout id; determine how we want to handle more layouts
INSERT INTO layout_state (
    layout_id,
    item_revision,
    camera_revision,
    camera_center_x,
    camera_center_y,
    zoom_bps,
    next_sort_seq
) VALUES ('home', 0, 0, 0, 0, 10000, 1);

CREATE TABLE layout_items (
    layout_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('session', 'project', 'persona')),
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

CREATE INDEX layout_items_render_order_idx
ON layout_items (layout_id ASC, z_index ASC, sort_seq ASC, id ASC);
