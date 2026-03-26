function calculateFee(jobAmount) {
  const platformFee = jobAmount < 450 ? 20 : 35;
  const contractorPayout = jobAmount - platformFee;
  return { platformFee, contractorPayout, jobAmount };
}

module.exports = { calculateFee };
