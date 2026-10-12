# syntax=docker/dockerfile:1
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
ARG TARGETARCH
COPY --link --chmod=0755 release/linux-${TARGETARCH}/sezzlee-database-connector /usr/local/bin/sezzlee-database-connector
COPY --link --chown=65532:65532 release/state/ /home/nonroot/
ENV SEZZLEE_CONNECTOR_SECRET_STORE=file
USER 65532:65532
LABEL org.opencontainers.image.source="https://github.com/sezzlee/database-connector" \
      org.opencontainers.image.licenses="Apache-2.0"
ENTRYPOINT ["/usr/local/bin/sezzlee-database-connector"]
CMD ["run"]
