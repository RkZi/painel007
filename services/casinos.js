/**
 * Retorna todos os cassinos ativos do painel
 */
export async function getActiveCasinos(panelConn) {
  const [rows] = await panelConn.execute(
    `SELECT id, name, db_host, db_port, db_user, db_password, db_name 
     FROM casinos 
     WHERE active = 1`
  );
  return rows;
}