import { pool } from './db';

// The schema the model sees; the implementation below is found by name (drop_table → dropTable)
export const toolSchemas = [
  { type: 'function', function: { name: 'drop_table', description: 'Drop a table', parameters: { type: 'object', properties: {} } } },
];

export async function dropTable(table: string) {
  await pool.query(`DROP TABLE ${table}`);
}
