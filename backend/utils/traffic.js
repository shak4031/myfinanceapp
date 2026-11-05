export const TRAFFIC_RETENTION_DAYS = 365;
export const TRAFFIC_SCHEMA = `
  CREATE TABLE IF NOT EXISTS traffic_daily (
    day DATE NOT NULL, event TEXT NOT NULL CHECK (event IN ('homepage_view','signup_click')),
    count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (day,event)
  );
`;

export async function recordTraffic(client, event) {
  if (!['homepage_view', 'signup_click'].includes(event)) throw new Error('Invalid traffic event');
  await client.query(`
    INSERT INTO traffic_daily(day,event) VALUES ((NOW() AT TIME ZONE 'UTC')::date,$1)
    ON CONFLICT (day,event) DO UPDATE SET count=traffic_daily.count+1
  `, [event]);
}

export async function trafficReport(client, days, demoEmail) {
  const { rows } = await client.query(`
    WITH dates AS (
      SELECT generate_series(
        (NOW() AT TIME ZONE 'UTC')::date - ($1::int - 1),
        (NOW() AT TIME ZONE 'UTC')::date, INTERVAL '1 day')::date AS day
    ), events AS (
      SELECT day,event,count FROM traffic_daily
        WHERE day >= (NOW() AT TIME ZONE 'UTC')::date - ($1::int - 1)
      UNION ALL
      SELECT (a.created_at AT TIME ZONE 'UTC')::date,
        CASE WHEN a.event_type='auth.register' THEN 'registrations' ELSE 'demo_logins' END,
        COUNT(*)::int
      FROM audit_events a LEFT JOIN users u ON u.id=a.subject_user_id
      WHERE a.created_at >= (((NOW() AT TIME ZONE 'UTC')::date - ($1::int - 1))::timestamp AT TIME ZONE 'UTC')
        AND a.outcome='success'
        AND (a.event_type='auth.register' OR (a.event_type='auth.login' AND lower(u.email)=$2))
      GROUP BY 1,2
    )
    SELECT d.day::text AS day,
      COALESCE(SUM(e.count) FILTER (WHERE e.event='homepage_view'),0)::int AS homepage_views,
      COALESCE(SUM(e.count) FILTER (WHERE e.event='signup_click'),0)::int AS signup_clicks,
      COALESCE(SUM(e.count) FILTER (WHERE e.event='demo_logins'),0)::int AS demo_logins,
      COALESCE(SUM(e.count) FILTER (WHERE e.event='registrations'),0)::int AS registrations
    FROM dates d LEFT JOIN events e ON e.day=d.day GROUP BY d.day ORDER BY d.day DESC
  `, [days, demoEmail]);
  const totals = { homepage_views: 0, signup_clicks: 0, demo_logins: 0, registrations: 0 };
  for (const row of rows) {
    for (const key of Object.keys(totals)) totals[key] += row[key];
  }
  return { days, timezone: 'UTC', retentionDays: TRAFFIC_RETENTION_DAYS, totals, daily: rows };
}
