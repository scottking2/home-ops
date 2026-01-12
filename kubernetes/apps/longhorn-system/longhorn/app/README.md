# Longhorn Backup Configuration

## Automated Backup Jobs

Three recurring backup jobs are configured:

### 1. backup-postgres-daily
- **Schedule**: Daily at 2:00 AM
- **Retention**: 7 days
- **Volumes**: PostgreSQL databases
  - `pvc-8c57809a-deb4-4178-a61e-dcc1169ef817` (postgres-1)
  - `pvc-ff67dc9d-c072-41d5-9e7b-2f7b8289019d` (postgres-2)
  - `pvc-08bd24ae-a871-42fb-a89d-d734e2ecdb6e` (postgres-6)

### 2. backup-apps-daily
- **Schedule**: Daily at 3:00 AM
- **Retention**: 7 days
- **Volumes**: Application data
  - `pvc-befd202e-7083-4909-a6e1-77f6c7e9bc97` (mealie-pvc)

### 3. backup-media-weekly
- **Schedule**: Weekly on Sunday at 4:00 AM
- **Retention**: 4 weeks
- **Volumes**: Media libraries
  - `pvc-1951e601-a1ee-4615-ac8d-2be29104840b` (tautulli)
  - `pvc-332a1908-5cb2-4f23-a599-b49a858a0a0e` (tautulli-config)
  - `plex-pv` (plex)

## Backup Target

- **Type**: NFS
- **Location**: `nfs://${SECRET_NFS_SERVER}:/volume2/longhorn-backups`
- **Synology NAS**: `${SECRET_NFS_SERVER}`

## Adding Backup Jobs to New Volumes

When you create a new PVC that needs backups, add a label to attach a recurring job:

```bash
# For critical data (PostgreSQL, etc.) - daily backups
kubectl -n longhorn-system label volume/<VOLUME-NAME> \
  recurring-job.longhorn.io/backup-postgres-daily=enabled

# For application data - daily backups
kubectl -n longhorn-system label volume/<VOLUME-NAME> \
  recurring-job.longhorn.io/backup-apps-daily=enabled

# For media/large data - weekly backups
kubectl -n longhorn-system label volume/<VOLUME-NAME> \
  recurring-job.longhorn.io/backup-media-weekly=enabled
```

**Or label the PVC** (Longhorn will sync labels from PVC to Volume automatically):

```bash
kubectl label pvc/<PVC-NAME> -n <NAMESPACE> \
  recurring-job.longhorn.io/backup-apps-daily=enabled
```

## Manual Backup via CLI

To create a one-time backup:

```bash
kubectl create -f - <<EOF
apiVersion: longhorn.io/v1beta2
kind: Backup
metadata:
  name: manual-backup-$(date +%Y%m%d-%H%M%S)
  namespace: longhorn-system
spec:
  snapshotName: ""  # Creates new snapshot
  labels:
    manual: "true"
EOF
```

## Restore from Backup

1. Open Longhorn UI: `https://longhorn.REDACTED_DOMAIN`
2. Go to **Backup** → Select backup target **longhorn-backups**
3. Find your backup → Click **⋮** → **Restore**
4. Select restore options and create new volume or overwrite existing

## Troubleshooting

### Synology @eaDir Folders

If backups fail with `invalid volume name @eaDir` error:

```bash
# Mount NFS and clean up Synology metadata
kubectl run nfs-cleanup --image=alpine --restart=Never -- sleep 3600
kubectl exec nfs-cleanup -- sh -c "find /mnt/backup -name '@eaDir' -type d -exec rm -rf {} +"
kubectl delete pod nfs-cleanup
```

### Prevent @eaDir from Returning

In Synology DSM:
1. **Control Panel** → **Indexing Service**
2. Ensure `longhorn-backups` is NOT in the indexed folders list
3. **File Services** → **SMB** → Advanced → Disable "Spotlight support"

## Monitoring Backups

View backup status:

```bash
# Check backup jobs
kubectl get recurringjobs -n longhorn-system

# Check backup target health
kubectl get backuptargets -n longhorn-system

# View recent backups
kubectl get backups -n longhorn-system
```

In Longhorn UI:
- **Dashboard** → View backup statistics
- **Backup** → See all backups and their status
- **Volume** → Select volume → **Snapshot** tab → See backup history
