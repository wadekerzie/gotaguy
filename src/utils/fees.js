function calculateFee(jobAmount) {
  const platformFee = Math.max(25, Math.min(250, jobAmount * 0.10));
  const contractorPayout = jobAmount - platformFee;
  return { platformFee, contractorPayout, jobAmount };
}

module.exports = { calculateFee };
