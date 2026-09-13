# The production front door. `apk upgrade` pulls Alpine security fixes newer
# than the pinned digest (Trivy found fixable libuuid CVEs in the stock image).
FROM nginx:1.30.4-alpine@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c
RUN apk upgrade --no-cache
