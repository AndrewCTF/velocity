# The production front door. `apk upgrade` pulls Alpine security fixes newer
# than the pinned digest (Trivy found fixable libuuid CVEs in the stock image).
FROM nginx:1.30.6-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951
RUN apk upgrade --no-cache
