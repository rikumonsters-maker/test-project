ALTER TABLE groups RENAME COLUMN icon_id TO group_icon;
ALTER TABLE groups RENAME COLUMN icon_color_id TO group_icon_color;

UPDATE groups SET group_icon = CASE
  WHEN group_icon IS NULL THEN 'friends'
  WHEN group_icon IN ('friends', 'university', 'work', 'game', 'food', 'travel', 'sports') THEN group_icon
  WHEN group_icon = 'music' THEN 'karaoke'
  WHEN group_icon = 'book' THEN 'study'
  ELSE 'other'
END;

UPDATE groups SET group_icon_color = CASE group_icon_color
  WHEN 'mint' THEN 'green'
  WHEN 'sage' THEN 'green'
  WHEN 'sky' THEN 'lightblue'
  WHEN 'lavender' THEN 'purple'
  WHEN 'rose' THEN 'pink'
  WHEN 'coral' THEN 'orange'
  WHEN 'butter' THEN 'orange'
  WHEN 'slate' THEN 'gray'
  ELSE 'green'
END;
