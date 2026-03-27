function calculateFee(jobAmount) {
  const platformFee = Math.max(25, Math.min(100, jobAmount * 0.10));
  const contractorPayout = jobAmount - platformFee;
  return { platformFee, contractorPayout, jobAmount };
}

module.exports = { calculateFee };
