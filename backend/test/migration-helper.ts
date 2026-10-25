export async function applySQL(db:D1Database,file:string) {
  const triggers:string[]=[];
  const rest=file.replace(/CREATE TRIGGER[\s\S]*?END;/g,sql=>{triggers.push(sql);return '';});
  for(const sql of [...rest.split(';').map(s=>s.replace(/^\s*--.*$/gm,'').trim()).filter(Boolean),...triggers]) await db.prepare(sql).run();
}
