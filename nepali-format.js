const DECIMALS = parseInt(process.env.DECIMALS || "2", 10);

function roundNormal(n, places = DECIMALS) {
  const p = 10 ** places;
  return Math.round((Number(n) + Number.EPSILON) * p) / p;
}

function formatNepali(num) {
  num = roundNormal(num);
  const isNegative = num < 0;
  const abs = Math.abs(num);
  let [intPart, decPart = ""] = abs.toFixed(DECIMALS).split(".");

  let lastThree = intPart.slice(-3);
  let otherNumbers = intPart.slice(0, -3);
  if (otherNumbers !== "") lastThree = "," + lastThree;
  const formattedInt = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + lastThree;

  const decimal = DECIMALS > 0 ? "." + decPart : "";
  return (isNegative ? "−" : "") + formattedInt + decimal;
}

module.exports = { formatNepali, roundNormal, DECIMALS };