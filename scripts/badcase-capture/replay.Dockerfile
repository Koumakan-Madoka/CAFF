# Offline build context contains ONLY this Dockerfile and ripgrep.deb.
# Package: https://deb.debian.org/debian/pool/main/r/rust-ripgrep/ripgrep_13.0.0-4+b2_amd64.deb
FROM sha256:5738ddb39d7f2420a5d43b86be907de09eed5c0751a034f233b3a0aa2d5cbebe
LABEL caff.badcase.replay-recipe="wikiskill-rg13-v1" \
      caff.badcase.base-image="sha256:5738ddb39d7f2420a5d43b86be907de09eed5c0751a034f233b3a0aa2d5cbebe" \
      caff.badcase.ripgrep-deb="feba1aea6022d84c67293686fe82132f7283d3c485a2cbd5af5c0e210615ecc2"
COPY ripgrep.deb /tmp/ripgrep.deb
RUN echo 'feba1aea6022d84c67293686fe82132f7283d3c485a2cbd5af5c0e210615ecc2  /tmp/ripgrep.deb' | sha256sum -c - \
    && dpkg -i /tmp/ripgrep.deb \
    && test "$(dpkg-query -W -f='${Version}' ripgrep)" = '13.0.0-4+b2' \
    && test "$(rg --version | head -n 1)" = 'ripgrep 13.0.0' \
    && rm /tmp/ripgrep.deb
