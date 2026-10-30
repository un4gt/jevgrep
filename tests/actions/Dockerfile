FROM catthehacker/ubuntu:act-24.04
# GitHub hosted tests run as a regular user. Root bypasses chmod-based fixtures.
RUN useradd --uid 1001 --create-home --shell /bin/bash runner
# act's medium image omits Rust; GitHub's hosted Ubuntu runners include rustup.
ENV CARGO_HOME=/opt/rust/cargo RUSTUP_HOME=/opt/rust/rustup
ENV PATH=/opt/rust/cargo/bin:$PATH
RUN curl --fail --location --retry 2 https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain none --no-modify-path \
    && rm /tmp/rustup-init.sh
# Run act itself in Linux too to avoid Windows artifact-server path handling.
# Child jobs still run in separate containers.
RUN curl --fail --location --retry 2 https://github.com/nektos/act/releases/download/v0.2.92/act_Linux_x86_64.tar.gz -o /tmp/act.tar.gz \
    && echo 'c9e13f0eb77948a6d02eb2e06fa7220addfc5b9927ed2a1b35bcdae5441ac7a1  /tmp/act.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/act.tar.gz -C /usr/local/bin act \
    && curl --fail --location --retry 2 https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip -o /tmp/bun.zip \
    && unzip -q /tmp/bun.zip -d /tmp \
    && install /tmp/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/act.tar.gz /tmp/bun.zip /tmp/bun-linux-x64
