# Home Automation Stack

This namespace contains Home Assistant, Frigate, and Mosquitto MQTT broker for home automation and security camera management.

## Components

### 1. Mosquitto MQTT Broker
- **Purpose**: Message broker for Home Assistant and Frigate communication
- **Service**: `mosquitto.home-automation.svc.cluster.local:1883`
- **LoadBalancer IP**: `10.0.0.236`

### 2. Home Assistant
- **URL**: https://ha.${SECRET_DOMAIN}
- **Purpose**: Home automation platform
- **Storage**: 10Gi on Longhorn
- **Configuration**: Will be created on first startup

### 3. Frigate
- **URL**: https://frigate.${SECRET_DOMAIN}
- **Purpose**: NVR with AI object detection for security cameras
- **Storage**: Configured for NFS to Synology NAS (needs configuration)

## Setup Instructions

### 1. Configure Synology NAS for Frigate Storage

1. On your Synology NAS:
   - Enable NFS Service (Control Panel → File Services → NFS)
   - Create a shared folder called `frigate` (or your preferred name)
   - Set NFS permissions:
     - Client: Your cluster network (e.g., `10.0.0.0/24`)
     - Privilege: Read/Write
     - Squash: Map all users to admin
     - Security: sys
     - Enable asynchronous

2. Update the Frigate PVC:
   ```bash
   # Edit frigate/app/pvc.yaml if needed
   # The NFS server uses ${SECRET_NFS_SERVER} variable from cluster secrets
   # Adjust the path if different from default:
   path: /volume1/frigate  # Your NFS share path
   ```

### 2. Deploy the Stack

```bash
# IMPORTANT: The deployments are currently DISABLED for review
# To enable, edit kubernetes/apps/home-automation/kustomization.yaml
# and uncomment the three ks.yaml lines

# After review and uncommenting:
cd ~/home-ops
git add kubernetes/apps/home-automation/
git commit -m "Enable home automation stack"
git push

# Flux will automatically detect and deploy the changes
# Monitor the deployment:
flux get kustomizations -n flux-system | grep home
kubectl get pods -n home-automation -w
```

### 3. Configure Frigate Cameras

1. Access Frigate at https://frigate.${SECRET_DOMAIN}
2. Edit the ConfigMap at `frigate/app/configmap.yaml`
3. Add your camera configurations:

```yaml
cameras:
  front_door:
    enabled: true
    ffmpeg:
      inputs:
        - path: rtsp://username:password@camera-ip:554/stream1  # Sub stream for detection
          roles:
            - detect
        - path: rtsp://username:password@camera-ip:554/stream0  # Main stream for recording
          roles:
            - record
    detect:
      width: 1920
      height: 1080
      fps: 5
    record:
      enabled: true
      retain:
        days: 30
```

### 4. Configure Home Assistant

1. Access Home Assistant at https://ha.${SECRET_DOMAIN}
2. Complete the initial setup wizard
3. Add the MQTT integration:
   - Server: `mosquitto.home-automation.svc.cluster.local`
   - Port: `1883`
4. Add the Frigate integration:
   - URL: `http://frigate.home-automation.svc.cluster.local:5000`

## Optional: Coral TPU Support

If you have a Coral TPU for AI acceleration:

1. Update the Frigate HelmRelease to mount the USB device:
```yaml
persistence:
  usb:
    type: hostPath
    hostPath: /dev/bus/usb
    globalMounts:
      - path: /dev/bus/usb
```

2. Update the Frigate config:
```yaml
detectors:
  coral:
    type: edgetpu
    device: usb
```

## Troubleshooting

### Check pod status:
```bash
kubectl get pods -n home-automation
kubectl logs -n home-automation deployment/home-assistant
kubectl logs -n home-automation deployment/frigate
```

### Check ingress:
```bash
kubectl get ingress -n home-automation
```

### Check PVC status:
```bash
kubectl get pvc -n home-automation
```

## Notes

- Home Assistant config is stored in Longhorn (10Gi)
- Frigate recordings should be stored on NFS for large capacity
- MQTT is configured without authentication (secure your network accordingly)
- Both services are accessible via ingress with SSL certificates