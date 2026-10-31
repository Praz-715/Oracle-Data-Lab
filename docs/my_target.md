Gas cuy 🔥 Sekarang kita naik level dari MariaDB ke OracleDB Data Lab.

Karena Oracle punya fitur enterprise yang jauh lebih luas—RAC, Data Guard, RMAN, tablespace, partitioning, PL/SQL, AWR, dan sebagainya—menurut gua target aplikasinya jangan sekadar memindahkan generator data MariaDB ke Oracle. Kita bikin platform khusus untuk testing, benchmarking, simulasi workload, dan observability Oracle Database.

Targetnya relevan untuk Oracle 11g, 12c, 19c, 21c, dan 26ai yang sering dipakai di lingkungan enterprise, dengan fitur tambahan untuk versi yang lebih baru.

# Roadmap OracleDB Data Lab


01\. Oracle Connection & Environment Manager

Prioritas P0

- Koneksi menggunakan Service Name atau SID.
- Oracle Thin JDBC-style equivalent via Node.js Oracle driver `oracledb` (node-oracledb).
- Dukungan CDB/PDB, dedicated/shared connection, dan wallet/TLS bila diperlukan.
- Informasi versi, edition, instance, database role, character set, dan uptime.
- Connection pool monitoring dan pengujian koneksi.


02\. Schema & Object Generator

Prioritas P0

- Generate puluhan sampai ratusan tabel.
- PK, FK, unique constraint, check constraint, dan index.
- View, materialized view, sequence, synonym.
- Package, procedure, function, trigger.
- Partitioned table, LOB, dan database object inventory.
- ERD serta dependency mapping antarb objek.


03\. Realistic Data Generator

Prioritas P0

- Data bisnis sintetis dengan relasi konsisten.
- 100 ribu, 1 juta, 10 juta, hingga puluhan juta baris.
- Bulk insert, array binding, dan batch commit.
- Generator NUMBER, VARCHAR2, DATE, TIMESTAMP, CLOB, BLOB.
- Data historis untuk partitioning dan analitik.
- Resume job, progress, deterministic seed, dan validasi referensial.


04\. Tablespace & Storage Lab

- Tablespace dan datafile inventory.
- Segment, extent, table size, index size, dan LOB size.
- Autoextend, free space, growth trend.
- TEMP dan UNDO monitoring.
- Simulasi pertumbuhan storage dan estimasi kapasitas.
- Deteksi tablespace mendekati batas kapasitas.


05\. Performance & SQL Benchmark Lab

- INSERT, SELECT, UPDATE, DELETE.
- JOIN, GROUP BY, subquery, analytic functions.
- Index scan versus full table scan.
- Bind variables versus literal SQL.
- Concurrent sessions dan mixed workload.
- Latency p50/p95/p99, TPS, rows/sec, error rate.
- SQL execution plan dan perbandingan hasil tuning.


06\. Instance & Session Monitoring

- Active/inactive sessions dan connection utilization.
- CPU, SGA, PGA, buffer cache, shared pool.
- Wait events, locks, blocking sessions, deadlocks.
- Redo generation, logical/physical reads.
- Long-running SQL dan temporary space usage.
- Alert log dan ORA-error monitoring bila akses tersedia.

## 7. Target lanjutan khusus Oracle Enterprise

Ini bagian yang bikin OracleDB Data Lab beda dari tool testing database biasa.


07\. RAC Cluster Lab

- Deteksi instance dan node RAC.
- Status instance, service, dan preferred/available instances.
- Distribusi sesi dan workload antarnode.
- Global Cache, interconnect, dan GC wait events.
- Perbandingan workload single-instance vs RAC.
- Simulasi dampak perpindahan service dan perubahan node.

Catatan: simulasi failover nyata memerlukan cluster pengujian khusus.


08\. Data Guard & Disaster Recovery Lab

- Identifikasi primary dan physical standby.
- Monitoring transport lag dan apply lag.
- Redo generation, shipping, dan apply rate.
- Status archived log serta gap detection.
- Role, protection mode, dan switchover readiness.
- Latihan switchover/failover pada lingkungan terisolasi.

Operasi perubahan role harus memerlukan konfirmasi eksplisit dan validasi kondisi database.


09\. RMAN Backup & Recovery Lab

- Inventaris backup set dan backup piece.
- Monitoring status, durasi, ukuran, dan throughput backup.
- Pemeriksaan archived log dan backup retention.
- Simulasi strategi full, incremental, dan archived-log backup.
- Restore validation serta recovery drill.
- Estimasi RPO/RTO berdasarkan hasil pengujian.

Uji restore sesungguhnya dilakukan pada database atau storage terpisah, bukan dengan menimpa database produksi.


10\. SQL Tuning Workbench

- SQL ID dan SQL execution statistics.
- Execution plan, estimated cost, dan cardinality.
- Index recommendation berdasarkan workload.
- Bind variable analysis.
- Perbandingan performa sebelum dan sesudah perubahan SQL.
- Analisis top SQL berdasarkan elapsed time, CPU, dan buffer gets.

AWR, ASH, SQL Tuning Advisor, dan beberapa fitur diagnosis memerlukan hak akses serta lisensi Oracle yang sesuai.


11\. Memory & Resource Lab

- SGA/PGA utilization.
- Buffer cache hit ratio dengan interpretasi yang tepat.
- Shared pool dan library cache.
- TEMP spill serta sort operations.
- PGA workarea dan penggunaan memori per proses jika tersedia.
- Resource Manager dan workload contention.

Fokusnya observasi dan rekomendasi terlebih dahulu; perubahan parameter tidak otomatis diterapkan.


12\. Advanced Object & Feature Lab

- Range, list, dan hash partitioning.
- Interval partitioning untuk data historis.
- CLOB/BLOB dan pengujian LOB.
- Global/local indexes dan index maintenance.
- Materialized view refresh.
- Compression dan In-Memory Column Store jika tersedia.
- Sequence throughput serta PL/SQL bulk processing.

Setiap fitur perlu diperiksa kompatibilitas versi, edition, konfigurasi, dan lisensinya.

## 8. Fitur pendukung yang jangan dilupakan

| No. | Target                           | Fungsi                                                                                                              |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 13  | Schema Compare & Migration Lab   | Membandingkan DDL antarschema/database, mendeteksi perbedaan objek, dan menghasilkan script migrasi untuk direview. |
| 14  | Data Quality Validator           | Mengecek orphan rows, duplikasi, NULL, konsistensi transaksi, serta ketidaksesuaian agregat.                        |
| 15  | Workload Replay & Scenario Lab   | Memutar ulang workload sintetis yang tercatat, dengan batas konkurensi dan durasi.                                  |
| 16  | Backup Dataset & Cleanup Manager | Menandai data milik job tertentu, membersihkan data uji secara aman, dan mencatat tindakan.                         |
| 17  | Monitoring Integration           | Integrasi Prometheus, Grafana, Node Exporter, dan metrik Oracle yang tersedia.                                      |
| 18  | Reports & Benchmark History      | Menyimpan hasil benchmark, membandingkan run, serta membuat laporan HTML/CSV/JSON.                                  |
| 19  | Oracle Error & Alert Analyzer    | Mengelompokkan ORA error, menampilkan konteks, dan membantu analisis awal dari alert log atau trace yang diberikan. |
| 20  | Multiversion Compatibility Lab   | Menguji perbedaan fitur, tipe data, DDL, dan perilaku query pada Oracle 11g/12c/19c/21c/26ai/versi lebih baru.               |

## 9. Target dashboard utama

Database status

## Connected

Role, version, instance

Workload

## Live metrics

Sessions, TPS, waits

Storage

## Capacity

Tablespace, TEMP, UNDO

Benchmark

## Performance

Latency, throughput, errors

Grafik yang harus tersedia

- CPU, memory, dan active sessions dari waktu ke waktu.
- SQL throughput dan latency.
- Tablespace utilization serta pertumbuhan storage.
- Redo generation dan Data Guard lag.
- Backup duration dan ukuran backup.
- Perbandingan benchmark berdasarkan versi, konfigurasi, dan jumlah concurrent users.

## 10. Urutan pengerjaan yang paling masuk akal

Jangan langsung membangun 20 modul sekaligus. Pecah jadi beberapa fase supaya setiap versi bisa dipakai untuk testing sungguhan.

Phase 1 — Core Platform

Mulai di sini

Connection Manager, Object Generator, Synthetic Data Generator, Schema Explorer, Data Quality Validator.

Target: bisa membuat schema, mengisi jutaan data, dan memvalidasi hasilnya.

Phase 2 — Performance Lab

SQL benchmark, concurrent workload, execution plan, latency percentiles, SQL tuning, dan benchmark history.

Target: mengukur kemampuan Oracle secara terukur dan repeatable.

Phase 3 — Monitoring & Observability

Instance monitoring, sessions, waits, SGA/PGA, storage, alert logs, Prometheus dan Grafana.

Target: mendapatkan gambaran kondisi database dari satu dashboard.

Phase 4 — Enterprise & HA/DR

RAC, Data Guard, RMAN, schema comparison, recovery drill, dan compatibility testing.

Target: menguji ketahanan, pemulihan, serta perilaku lingkungan Oracle enterprise.

## 11. Arsitektur teknologi

Untuk konsisten dengan program MariaDB yang sebelumnya, tetap gunakan vanilla HTML, CSS, dan JavaScript di frontend. Backend-nya menggunakan Node.js dan driver `oracledb`.

Frontend

Vanilla HTML · CSS · JavaScript · SVG/Canvas

Backend API — Node.js

Connection pool · Jobs · Generator · Benchmark · Validation

Oracle Database

11g · 12c · 19c · 21c · 26ai ·  versi yang lebih baru sesuai kompatibilitas driver

Opsional: Monitoring Stack

Prometheus · Grafana · Exporter

Catatan: gunakan Node.js `oracledb` Thin mode jika cocok dengan versi Oracle dan kebutuhan koneksi. Oracle 11g dan fitur koneksi tertentu mungkin membutuhkan konfigurasi atau Thick mode dengan Oracle Client yang sesuai. Verifikasi kompatibilitas sebelum menetapkan dukungan versi.

## 12. Definisi target selesai

Menurut gua, OracleDB Data Lab baru layak disebut versi pertama yang berhasil kalau memenuhi kriteria berikut:

- Bisa terkoneksi dan mengidentifikasi lingkungan Oracle.
- Bisa membuat schema dengan banyak tabel dan objek yang saling berelasi.
- Bisa generate dan memvalidasi jutaan data sintetis.
- Bisa menjalankan workload benchmark dengan hasil yang dapat dibandingkan.
- Bisa menampilkan statistik nyata dari Oracle, bukan angka simulasi.
- Bisa memonitor penggunaan storage, sesi, dan performa SQL.
- Bisa mencatat job, error, konfigurasi, serta hasil pengujian.
- Memiliki pengamanan agar benchmark dan cleanup tidak merusak database produksi.

Saran terakhir: jadikan Core Platform + Data Generator + Performance Lab sebagai MVP. Itu sudah memberikan nilai paling besar untuk testing Oracle. Setelah stabil, baru tambahkan RAC, Data Guard, dan RMAN sebagai modul enterprise terpisah. Ketiganya perlu lingkungan pengujian yang sesuai dan tidak cukup diuji hanya dengan satu koneksi database.

Untuk fitur berlisensi seperti Diagnostic Pack dan Tuning Pack, desain modulnya agar bisa berjalan dengan metrik dasar yang tersedia tanpa mengandalkan fitur berlisensi tersebut.