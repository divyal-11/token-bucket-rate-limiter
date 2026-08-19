async function fireRequests() {
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(
      fetch("http://localhost:3000/check?clientKey=racetest2").then(res => res.json() as Promise<{ result: string }>)
    );
  }

  const results = await Promise.all(promises);
  const allowCount = results.filter(r => r.result === "ALLOW").length;
  const denyCount = results.filter(r => r.result === "DENY").length;

  console.log(`ALLOW: ${allowCount}, DENY: ${denyCount}`);
}

fireRequests();