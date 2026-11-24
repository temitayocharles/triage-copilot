export interface SampleIncident {
  id: string;
  title: string;
  body: string;
}

export const SAMPLE_INCIDENTS: SampleIncident[] = [
  {
    id: "oom-deploy",
    title: "Deploy crash loop: OOMKilled",
    body: `Incident: payments-api pods crash-looping after today's 14:02 deploy (v2.18.0).
Users see 502 errors on checkout. Started 14:03, still ongoing.

kubectl get pods -n prod:
payments-api-7f9c4d6b9-x2k4q   0/1   CrashLoopBackOff   12   8m
payments-api-7f9c4d6b9-p8z1m   0/1   CrashLoopBackOff   11   8m

kubectl describe pod payments-api-7f9c4d6b9-x2k4q:
  Last State: Terminated, Reason: OOMKilled, Exit Code: 137
  Limits: memory 512Mi, cpu 500m
  Requests: memory 256Mi, cpu 250m

Logs before the kill:
14:02:31 INFO  starting payments-api v2.18.0
14:02:44 INFO  loading price rules cache (184,203 rules)
14:02:58 WARN  heap usage 487Mi / 512Mi
14:03:01 FATAL java.lang.OutOfMemoryError: Java heap space

Rollback to v2.17.0 has NOT been done yet. No config change in this release,
only the new price-rules cache that loads at startup.`,
  },
  {
    id: "postgres-pool",
    title: "Database: connection slots exhausted",
    body: `Incident: API latency spiked at 09:41, then most requests started failing
with 500 errors. Checkout and login both affected. Database CPU is only 22%.

App logs (api-gateway):
09:41:12 ERROR HikariPool - Connection is not available, request timed out after 30000ms
09:41:15 ERROR org.postgresql.util.PSQLException: FATAL: remaining connection slots
are reserved for non-replication superuser connections
09:41:15 ERROR checkout-service: could not get JDBC Connection

Postgres (RDS db.m5.large, max_connections = 100):
SELECT count(*) FROM pg_stat_activity;  -> 97
SELECT application_name, count(*) FROM pg_stat_activity GROUP BY 1;
  reporting-worker   58
  api-gateway        31
  checkout-service    8

The reporting-worker job started at 09:40 (new nightly rollup moved to a morning
schedule). It opens one connection per thread and the pool size was left at the
default of 60. No recent deploy to api-gateway.`,
  },
  {
    id: "tls-expired",
    title: "TLS certificate expired",
    body: `Incident: users report "Your connection is not private" in Chrome since
07:15 this morning on app.example.com. Mobile app API calls are failing with
certificate errors. The site itself is up; curl -k works fine.

Browser error: NET::ERR_CERT_DATE_INVALID
Subject: app.example.com
Issuer: Let's Encrypt Authority X3

openssl s_client -connect app.example.com:443 -servername app.example.com:
  Verify return code: 10 (certificate has expired)
  Not After: Nov 23 06:14:00 2026 GMT

Ingress: nginx-ingress on GKE, cert-manager v1.14, ClusterIssuer letsencrypt-prod.
kubectl get certificate -n prod:
  app-tls   Not Ready   Expired  62m

cert-manager logs:
  06:15:02 ERROR failed to request certificate: 429 urn:ietf:params:acme:error:rateLimited
  "too many failed authorizations recently"
  06:20:11 INFO  next renewal attempt in 1h

The HTTP-01 challenge path /.well-known/acme-challenge/ returns 404 from the
ingress since last week's routing change.`,
  },
];
