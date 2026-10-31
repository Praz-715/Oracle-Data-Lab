

# OracleDB Data Lab — Roadmap, Target Features & Tech Stack

## 1. Vision

OracleDB Data Lab adalah platform untuk testing, benchmarking, synthetic data generation, dan observability Oracle Database.

Tujuannya bukan sekadar membuat data dummy, tetapi membangun platform yang membantu DBA dan developer untuk:

- Menghasilkan jutaan hingga puluhan juta baris data sintetis yang realistis.
- Membuat banyak tabel dan database objects dengan relasi yang konsisten.
- Melakukan pengujian performa SQL dan concurrent workload.
- Memantau kondisi database, session, memory, storage, dan SQL.
- Menguji berbagai fitur enterprise Oracle Database.
- Membandingkan performa antarversi, konfigurasi, dan skenario workload.
- Mengembangkan simulasi RAC, Data Guard, dan RMAN pada lingkungan pengujian.

Target awal adalah Oracle Database 11g, 12c, 19c, 21, dan 26ai, dengan dukungan versi lebih baru berdasarkan kompatibilitas driver dan fitur.

## 2. Technology Stack

### 2.1 Frontend

| Teknologi                   | Fungsi                                          |
| --------------------------- | ----------------------------------------------- |
| Nuxt 3 atau Nuxt 4          | Framework aplikasi berbasis Vue                 |
| Vue 3 Composition API       | Reactive state dan komponen UI                  |
| TypeScript                  | Type safety untuk komponen, API, dan model data |
| Motion for Vue (`motion-v`) | Animasi UI dan interaksi                        |
| CSS3                        | Styling, responsive layout, dan design tokens   |
| SVG / Canvas                | Visualisasi grafik dan chart                    |
| Nuxt UI (opsional)          | Komponen UI siap pakai dan aksesibel            |

Pilih satu major version Nuxt yang stabil ketika project dimulai, lalu gunakan secara konsisten.

Motion for Vue digunakan untuk:

- Page transition.
- Sidebar expand/collapse.
- Dialog dan drawer animation.
- Dropdown dan popover.
- Animated progress bar untuk data generation.
- Transisi status job.
- Animasi perubahan daftar session, alert, dan job.
- Feedback visual saat operasi berhasil atau gagal.

Motion harus digunakan secara fungsional, bukan sekadar dekorasi. Operasi database tidak boleh dinyatakan berhasil sebelum backend mengonfirmasi hasilnya.

Dukung `prefers-reduced-motion` untuk pengguna yang membatasi animasi.

### 2.2 Backend

| Teknologi                             | Fungsi                                       |
| ------------------------------------- | -------------------------------------------- |
| Node.js                               | Runtime JavaScript                           |
| Nuxt Server Routes / Nitro            | Backend API                                  |
| `oracledb`                            | Driver koneksi Oracle Database               |
| Server-Sent Events (SSE) atau polling | Progress update job                          |
| Background job runner                 | Data generation dan benchmark jangka panjang |
| Persistent job store                  | Menyimpan status dan histori pekerjaan       |

Backend menangani koneksi database, eksekusi SQL, validasi input, pengelolaan job, dan benchmark.

Job besar tidak boleh bergantung pada satu HTTP request yang berjalan terlalu lama.

### 2.3 Database

- Oracle Database 11g.
- Oracle Database 12c.
- Oracle Database 19c.
- Oracle Database 21c.
- Oracle Database 26ai.
- Versi Oracle yang lebih baru sesuai kompatibilitas driver dan fitur.

Gunakan `node-oracledb` Thin mode jika memenuhi kebutuhan koneksi. Versi Oracle yang lebih lama atau kebutuhan koneksi tertentu mungkin membutuhkan Thick mode dengan Oracle Client yang kompatibel.

Tidak semua fitur Oracle tersedia di setiap versi, edition, konfigurasi, atau lisensi.

### 2.4 Developer Experience & Testing

- npm untuk package management.
- ESLint dan Prettier.
- TypeScript type checking.
- Vitest untuk unit test.
- Integration test menggunakan database pengujian.
- Playwright untuk end-to-end browser testing jika diperlukan.
- `.env` untuk konfigurasi development.
- Docker Compose untuk aplikasi dan layanan pendukung jika dibutuhkan.

Oracle Database dapat dijalankan terpisah karena batasan platform, lisensi, dan ketersediaan image.

### 2.5 Optional Monitoring Stack

- Prometheus.
- Grafana.
- Node Exporter.
- Oracle exporter atau custom metrics queries.

### Arsitektur keamanan

Browser tidak boleh terhubung langsung ke Oracle Database.

Semua akses database harus melewati server-side API atau backend worker yang terkontrol.

## 3. Core Modules

### 3.1 Oracle Connection & Environment Manager — P0

Fitur:

- Koneksi menggunakan Service Name atau SID.
- Deteksi database CDB/PDB jika tersedia.
- Dukungan dedicated/shared connections.
- Wallet/TLS jika dibutuhkan.
- Informasi database version dan edition.
- Informasi instance, database role, character set, dan uptime.
- Test Connection.
- Diagnostik kesalahan koneksi.
- Monitoring connection pool.

Security requirements:

- Password tidak boleh ditampilkan kembali setelah dikirim.
- Credential harus disimpan di server.
- Jangan menyimpan credential dalam browser local storage.
- Jangan mencatat password di log.
- Gunakan connection pool dengan batas koneksi yang jelas.

### 3.2 Schema & Object Generator — P0

Membuat puluhan hingga ratusan tabel dan database objects.

Objek yang didukung:

- Tables.
- Primary keys.
- Foreign keys.
- Unique constraints.
- Check constraints.
- Indexes dan composite indexes.
- Views.
- Materialized views.
- Sequences.
- Synonyms.
- Procedures.
- Functions.
- Packages.
- Triggers.
- Partitioned tables.
- LOB columns.

Fitur tambahan:

- Object inventory.
- Dependency mapping.
- ERD generator.
- DDL preview.
- DDL export.
- Schema comparison.
- Object creation status.

Semua DDL harus dapat direview sebelum diterapkan. Pembuatan objek harus dibatasi pada schema yang sudah diotorisasi.

### 3.3 Realistic Synthetic Data Generator — P0

Target kapasitas awal:

| Preset | Target data               |
| ------ | ------------------------- |
| Small  | Sekitar 100.000 baris     |
| Medium | Sekitar 1 juta baris      |
| Large  | Sekitar 10 juta baris     |
| XL     | Sekitar 50 juta baris     |
| Custom | Jumlah sesuai konfigurasi |

Angka tersebut merupakan target awal yang dapat disesuaikan berdasarkan ukuran record dan kapasitas storage.

Tipe data yang didukung:

- `NUMBER`
- `VARCHAR2`
- `DATE`
- `TIMESTAMP`
- `CLOB`
- `BLOB`

Fitur generator:

- Batch insert.
- Array binding.
- Configurable commit interval.
- Deterministic random seed.
- Progress reporting.
- Resume job.
- Error handling.
- Referential integrity validation.
- Storage estimation.
- Historical dataset generation.
- Business-rule validation.

Data harus sintetis dan tidak menggunakan informasi personal nyata.

Contoh aturan bisnis:

- Setiap order terhubung dengan customer yang valid.
- Setiap order memiliki satu atau lebih item.
- Harga item sesuai rentang harga produk.
- Total pembayaran konsisten dengan nilai order.
- Tanggal pengiriman tidak boleh mendahului tanggal order.
- Return tidak boleh melebihi kuantitas pembelian.
- Inventory movement harus konsisten dengan saldo persediaan.

Jangan menggunakan distribusi random seragam untuk semua kolom. Gunakan pola yang masuk akal, misalnya seasonality, repeat purchases, distribusi kategori, dan variasi status transaksi.

### 3.4 Tablespace & Storage Lab

Fitur:

- Tablespace inventory.
- Datafile inventory.
- Segment dan extent information.
- Table size.
- Index size.
- LOB size.
- Autoextend status.
- Free space.
- TEMP usage.
- UNDO usage.
- Storage growth trend.
- Capacity estimation.
- Warning untuk tablespace yang mendekati batas kapasitas.

Bedakan estimasi dari statistik segment dan hasil pengukuran yang lebih presisi.

### 3.5 Performance & SQL Benchmark Lab

Skenario benchmark:

1. Single-row INSERT.
2. Bulk INSERT.
3. SELECT by primary key.
4. Indexed filtering.
5. Full table scan.
6. UPDATE.
7. DELETE.
8. Multi-table JOIN.
9. GROUP BY dan agregasi.
10. Subquery.
11. Analytic functions.
12. Bind variables versus literal SQL.
13. Concurrent read workload.
14. Concurrent write workload.
15. Mixed read/write workload.
16. Transaction commit throughput.
17. Pagination.
18. Historical analytical queries.

Metrik yang dicatat:

- Operations per second.
- Rows inserted per second.
- Average latency.
- p50 latency.
- p95 latency.
- p99 latency.
- Error count.
- Timeout count.
- Total runtime.
- Benchmark configuration.

Fitur tambahan:

- Warm-up phase.
- Configurable concurrency.
- Configurable duration.
- Query execution plan capture jika tersedia.
- Historical benchmark comparison.
- Export hasil benchmark.

Setiap benchmark harus menyimpan informasi hardware, versi Oracle, konfigurasi, ukuran data, index, concurrency, dan durasi.

Berikan batas concurrency dan konfirmasi eksplisit sebelum menjalankan workload berat.

### 3.6 Instance & Session Monitoring

Fitur:

- Active dan inactive sessions.
- CPU utilization jika tersedia.
- SGA.
- PGA.
- Buffer cache.
- Shared pool.
- Wait events.
- Blocking sessions.
- Deadlocks.
- Redo generation.
- Logical reads.
- Physical reads.
- Long-running SQL.
- Temporary space usage.
- Alert log monitoring jika akses tersedia.
- ORA-error monitoring.

Jika metrik tidak tersedia karena privilege atau instrumentation, tampilkan status unavailable dengan penjelasan. Jangan mengganti metrik yang tidak tersedia dengan angka dummy.

## 4. Enterprise Oracle Modules

### 4.1 RAC Cluster Lab

Fitur:

- Deteksi RAC instances dan nodes.
- Instance status.
- Service status.
- Preferred dan available instances.
- Workload distribution.
- Global Cache monitoring.
- Interconnect monitoring.
- Global Cache wait events.
- Perbandingan workload single-instance dengan RAC.
- Simulasi dampak perpindahan service atau perubahan node.

Pengujian failover nyata membutuhkan cluster pengujian yang sesuai.

### 4.2 Data Guard & Disaster Recovery Lab

Fitur:

- Identifikasi primary dan physical standby.
- Transport lag monitoring.
- Apply lag monitoring.
- Redo generation.
- Redo shipping rate.
- Redo apply rate.
- Archived log inspection.
- Archive gap detection.
- Database role.
- Protection mode.
- Switchover readiness.
- Controlled switchover/failover drill.

Operasi perubahan role wajib memiliki:

- Pre-flight validation.
- Konfirmasi eksplisit.
- Pengecekan kondisi primary dan standby.
- Logging seluruh tindakan.
- Prosedur recovery jika pengujian gagal.

Pengujian harus dilakukan pada lingkungan terisolasi.

### 4.3 RMAN Backup & Recovery Lab

Fitur:

- Backup set inventory.
- Backup piece inventory.
- Backup status.
- Backup duration.
- Backup size.
- Backup throughput.
- Archived log coverage.
- Retention coverage.
- Full backup testing.
- Incremental backup testing.
- Archived log backup testing.
- Restore validation.
- Recovery drill.
- Estimasi RPO dan RTO berdasarkan hasil pengujian.

Restore harus dilakukan pada database atau storage target terpisah, bukan dengan menimpa database produksi secara default.

### 4.4 SQL Tuning Workbench

Fitur:

- SQL ID inspection.
- SQL execution statistics.
- Execution plan.
- Estimated cost.
- Cardinality.
- Index recommendation.
- Bind-variable analysis.
- Before/after performance comparison.
- Top SQL berdasarkan elapsed time.
- Top SQL berdasarkan CPU.
- Top SQL berdasarkan buffer gets.

Catatan lisensi:

AWR, ASH, SQL Tuning Advisor, dan beberapa fitur diagnostik Oracle dapat membutuhkan privilege dan lisensi tertentu.

Sediakan alternatif diagnostik dasar yang tidak bergantung pada fitur berlisensi tersebut.

### 4.5 Memory & Resource Lab

Fitur:

- SGA utilization.
- PGA utilization.
- Buffer cache metrics.
- Shared pool metrics.
- Library cache indicators.
- Temporary spill.
- Sort operations.
- PGA workarea.
- Per-process memory jika tersedia.
- Resource Manager.
- Workload contention.

Aplikasi harus memulai dari observasi dan rekomendasi. Jangan otomatis mengubah parameter instance-wide.

### 4.6 Advanced Object & Feature Lab

Fitur:

- Range partitioning.
- List partitioning.
- Hash partitioning.
- Interval partitioning.
- CLOB/BLOB testing.
- Global indexes.
- Local indexes.
- Index maintenance.
- Materialized view refresh.
- Compression.
- In-Memory Column Store jika tersedia.
- Sequence throughput.
- PL/SQL bulk processing.

Sebelum menerapkan fitur, validasi versi, edition, konfigurasi, lisensi, dan batasan teknis Oracle yang relevan.

## 5. Supporting Modules

| No. | Modul                            | Tujuan                                                                                         |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| 13  | Schema Compare & Migration Lab   | Membandingkan DDL, menemukan perbedaan objek, dan menghasilkan script migrasi untuk direview.  |
| 14  | Data Quality Validator           | Mendeteksi orphan rows, duplikasi, NULL, inkonsistensi transaksi, dan ketidaksesuaian agregat. |
| 15  | Workload Replay & Scenario Lab   | Memutar ulang workload sintetis dengan batas concurrency dan durasi.                           |
| 16  | Backup Dataset & Cleanup Manager | Mengelola data milik job tertentu dan melakukan cleanup dengan aman.                           |
| 17  | Monitoring Integration           | Integrasi Prometheus, Grafana, Node Exporter, dan Oracle exporter.                             |
| 18  | Reports & Benchmark History      | Menyimpan hasil benchmark, membandingkan run, dan mengekspor HTML/CSV/JSON.                    |
| 19  | Oracle Error & Alert Analyzer    | Mengelompokkan ORA error dan membantu analisis alert log atau trace file.                      |
| 20  | Multiversion Compatibility Lab   | Menguji perbedaan fitur, tipe data, DDL, dan query antarversi Oracle.                          |

## 6. UI/UX Direction — Nuxt + Motion

### 6.1 Visual Direction

Desain aplikasi harus terasa seperti enterprise database operations console: modern, informatif, dan mudah dibaca.

Prinsip desain:

- Desktop-first, tetapi tetap responsif di tablet.
- Collapsible sidebar.
- Compact top navigation.
- Light mode dan dark mode.
- CSS variables untuk design tokens.
- Tipografi dan spacing konsisten.
- Tabel operasional yang padat tetapi mudah dibaca.
- Status warna konsisten untuk healthy, warning, failed, dan unavailable.
- Loading, empty, error, dan permission-denied states.
- Keyboard navigation.
- Visible focus indicators.
- Aksesibilitas yang baik.

Jangan mengorbankan keterbacaan data hanya demi dekorasi visual.

### 6.2 Motion for Vue

Gunakan Motion for Vue (`motion-v`) untuk interaksi yang memiliki tujuan jelas:

- Page transition.
- Sidebar expand/collapse.
- Dialog dan drawer.
- Dropdown dan popover.
- Animated progress bar.
- Perubahan daftar job.
- Transisi status.
- Success, warning, dan failure feedback.

Hindari animasi berlebihan pada live metrics agar dashboard tidak mengganggu proses monitoring.

Motion tidak boleh:

- Menunda operasi database.
- Menutupi error.
- Menampilkan status sukses sebelum backend mengonfirmasi.
- Menjadi satu-satunya cara untuk menyampaikan status.

Hormati preferensi `prefers-reduced-motion`.

### 6.3 Suggested Navigation

1. Overview
2. Connections
3. Dataset Sources
4. Schema Designer
5. Data Generator
6. Import Manager
7. Table Explorer
8. Visual Analytics
9. Performance Lab
10. SQL Tuning
11. Instance Monitoring
12. Tablespaces & Storage
13. RAC Lab
14. Data Guard Lab
15. RMAN Lab
16. SQL Diagnostics
17. Job History
18. Settings

Fitur yang membutuhkan Oracle feature, privilege, lisensi, atau infrastruktur yang tidak tersedia harus ditandai sebagai unavailable, bukan disimulasikan seolah-olah aktif.

## 7. Dashboard Targets

### 7.1 KPI Cards

- Database connection status.
- Oracle version.
- Database role.
- Instance name.
- Active sessions.
- Workload indicators.
- Tablespace utilization.
- Total objects.
- Total tables.
- Synthetic rows generated.
- Current insert throughput.
- Latest benchmark status.

### 7.2 Charts

- CPU, memory, dan active sessions dari waktu ke waktu.
- SQL throughput dan latency.
- Tablespace utilization dan storage growth.
- Redo generation dan Data Guard lag.
- Backup duration dan backup size.
- Benchmark comparison berdasarkan versi, konfigurasi, dan concurrent users.

Semua data dashboard harus berasal dari query Oracle atau sumber monitoring yang nyata.

Dilarang menggunakan angka hardcoded sebagai metrik live.

## 8. Suggested Project Structure

```
oracledb-data-lab/
├── app/
│   ├── assets/
│   │   └── css/
│   ├── components/
│   │   ├── layout/
│   │   ├── charts/
│   │   ├── database/
│   │   ├── generator/
│   │   └── benchmark/
│   ├── composables/
│   ├── layouts/
│   ├── middleware/
│   ├── pages/
│   ├── plugins/
│   └── types/
├── server/
│   ├── api/
│   ├── middleware/
│   ├── services/
│   ├── database/
│   ├── generators/
│   ├── jobs/
│   └── benchmarks/
├── sql/
│   ├── schema/
│   ├── views/
│   ├── procedures/
│   ├── indexes/
│   └── analytics/
├── datasets/
│   └── README.md
├── tests/
├── .env.example
├── .gitignore
├── nuxt.config.ts
├── package.json
└── README.md
```

Struktur dapat disesuaikan, tetapi tanggung jawab antarbagian harus tetap terpisah.

Jangan menempatkan credential atau kode database driver di komponen browser.

## 9. Implementation Roadmap

### Phase 1 — Core Platform

Fokus:

- Connection Manager.
- Schema dan Object Generator.
- Synthetic Data Generator.
- Table/Schema Explorer.
- Data Quality Validator.
- Job History dan progress reporting.
- Nuxt application shell.
- Navigation dan reusable UI components.
- Theme management.
- Motion for Vue dengan reduced-motion support.

Acceptance target: aplikasi dapat membuat schema berelasi, menghasilkan dataset besar, dan memvalidasi integritasnya.

### Phase 2 — Performance Lab

Fokus:

- INSERT, SELECT, JOIN, dan mixed workload benchmarks.
- Concurrency dan duration controls.
- Latency percentiles.
- Throughput metrics.
- Execution-plan capture jika tersedia.
- Benchmark history dan comparison.

Acceptance target: menghasilkan benchmark yang repeatable dan terdokumentasi.

### Phase 3 — Monitoring & Observability

Fokus:

- Instance dan session monitoring.
- Wait events.
- Blocking sessions.
- SGA/PGA.
- Storage.
- Alert-log analysis jika tersedia.
- Prometheus/Grafana integration.

Acceptance target: menampilkan metrik database nyata serta menjelaskan instrumentation yang tidak tersedia.

### Phase 4 — Enterprise & HA/DR

Fokus:

- RAC.
- Data Guard.
- RMAN.
- Schema comparison.
- Restore dan recovery drills.
- Multiversion compatibility tests.

Acceptance target: menjalankan pengujian terkontrol di lingkungan lab yang sesuai dengan safety checks dan audit log.

## 10. Safety & Operational Requirements

- Gunakan akun dengan least privilege.
- Pisahkan akun monitoring dan akun administrasi.
- Minta otorisasi sebelum membuat schema atau database objects.
- Jangan otomatis menghapus database atau schema.
- Jangan truncate tabel di luar cakupan testing yang dikonfigurasi.
- Tandai data hasil generate berdasarkan job agar cleanup dapat dibatasi.
- Wajibkan konfirmasi untuk operasi destruktif.
- Wajibkan konfirmasi untuk benchmark dengan beban tinggi.
- Batasi concurrency, batch size, timeout, retry, dan resource usage.
- Simpan credential hanya di sisi server.
- Gunakan parameterized SQL dan input validation.
- Simpan konfigurasi job, status, progress, error, dan timestamp.
- Buat job yang terputus dapat dipulihkan jika memungkinkan.
- Jadikan database produksi read-only secara default.
- Dokumentasikan privilege, batasan versi, dan kebutuhan lisensi.

## 11. Definition of Done for MVP

- Dapat terhubung ke Oracle dan mengidentifikasi environment.
- Dapat membuat schema dengan tabel dan objek yang berelasi.
- Dapat menghasilkan dan memvalidasi jutaan baris data sintetis.
- Dapat menjalankan SQL dan workload benchmark yang repeatable.
- Menampilkan statistik Oracle yang nyata, bukan mock data.
- Memantau storage, sessions, dan SQL performance.
- Menyimpan job, error, konfigurasi, dan benchmark results.
- Memiliki cleanup dan operational safeguards yang aman.
- Memiliki instalasi, konfigurasi, testing, dan troubleshooting documentation.
- Menggunakan Nuxt dan Vue components secara konsisten.
- Menggunakan Motion for Vue secara fungsional dan menghormati reduced-motion preferences.
- Semua akses Oracle hanya dilakukan di server-side.

## Final Recommendation

Mulai dari Core Platform + Synthetic Data Generator + Performance Lab. Ketiga modul ini memberikan nilai terbesar untuk testing Oracle.

Setelah platform inti stabil, tambahkan RAC, Data Guard, dan RMAN sebagai modul enterprise yang terpisah.

Target bukan hanya menghasilkan banyak baris data. Pengujian Oracle yang berguna membutuhkan relasi realistis, indeks yang sesuai, pola query bermakna, concurrent transactions, storage growth, dan pengukuran yang repeatable.

Final technology stack:

- Frontend: Nuxt + Vue 3 + TypeScript.
- UI motion: Motion for Vue (`motion-v`).
- Backend: Node.js + Nuxt Nitro server routes.
- Oracle driver: `node-oracledb`.
- Database: Oracle Database 11g, 12c, 19c, 21c, 26ai dan versi lebih baru sesuai kompatibilitas.
- Monitoring opsional: Prometheus + Grafana + Node Exporter / Oracle exporter.
- Testing: Vitest + integration tests + Playwright bila diperlukan.

Buat UI yang modern dan halus, tetapi tetap jadikan data Oracle yang nyata—bukan animasi atau placeholder—sebagai pusat pengalaman pengguna.