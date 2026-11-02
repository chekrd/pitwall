-- What was read before acting: each section in view before an action on a screen, how often and for how long
SELECT r.data ->> '$.screen' AS screen, s.key AS section, COUNT(*) AS before_actions,
  ROUND(AVG(s.value) / 1000.0, 1) AS avg_s, ROUND(MAX(s.value) / 1000.0, 1) AS max_s,
  (SELECT COUNT(*) FROM ev a WHERE a.name = 'read' AND a.data ->> '$.screen' = r.data ->> '$.screen') AS actions_with_reading
FROM ev r, json_each(r.data, '$.sections') s
WHERE r.name = 'read'
GROUP BY 1, 2 ORDER BY 1, before_actions DESC LIMIT 40;
