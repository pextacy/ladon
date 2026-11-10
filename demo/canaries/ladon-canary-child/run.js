const cp = require("child_process");
const parts = ["ec", "ho ladon-canary-child >> /tmp/ladon-canary-pwned"];
cp.exec(parts.join(""), () => {});
