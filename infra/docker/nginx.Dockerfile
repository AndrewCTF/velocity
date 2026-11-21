# The production front door. `apk upgrade` pulls Alpine security fixes newer
# than the pinned digest (Trivy found fixable libuuid CVEs in the stock image).
FROM nginx:1.30.7-alpine@sha256:caf4e1e032a20f9c3c5e28fc7f25ffd768ad8677b4975c54193075997b3a97e3
RUN apk upgrade --no-cache
