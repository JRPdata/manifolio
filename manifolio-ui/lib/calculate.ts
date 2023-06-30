import logger from "@/logger";
import { getBinaryCpmmBetInfoWrapper, fetchMarketCached } from "./market-utils";
import {
  BetModel,
  computePayoutDistribution,
  integrateOverPmf,
} from "./probability";

type NaiveKellyProps = {
  marketProb: number;
  estimatedProb: number;
  deferenceFactor: number;
};

export type Outcome = "YES" | "NO";
export type BetRecommendation = {
  amount: number;
  outcome: Outcome;
};

export type BetRecommendationFull = BetRecommendation & {
  shares: number;
  pAfter: number;
};

export type AsyncUnivariateFunction = (input: number) => Promise<number>;
export type UnivariateFunction = (input: number) => number;

type OddsType = "decimalOdds" | "englishOdds" | "impliedProbability";

/**
 * Convert between different formulations of betting odds, which are each useful for neatly
 * formulating different equations
 *
 * The three types of odds are:
 * - "decimalOdds": the normal odds you see in most places, e.g. decimal odds of 2.5 means
 * you get 2.5x your stake back INCLUDING your stake
 * - "englishOdds": decimal odds minus 1, e.g. english odds of 2.5 means you get 2.5x your
 * stake back PLUS your stake (so 3.5x in total)
 * - "impliedProbability": the probability implied by the odds
 */
export function convertOdds({
  from,
  to,
  value,
}: {
  from: OddsType;
  to: OddsType;
  value: number;
}) {
  if (from === to) {
    return value;
  }

  const decimalOdds = (() => {
    switch (from) {
      case "decimalOdds":
        return value;
      case "englishOdds":
        return value + 1;
      case "impliedProbability":
        return 1 / value;
      default:
        throw new Error(`Invalid 'from' value: ${from}`);
    }
  })();

  return (() => {
    switch (to) {
      case "decimalOdds":
        return decimalOdds;
      case "englishOdds":
        return decimalOdds - 1;
      case "impliedProbability":
        return 1 / decimalOdds;
      default:
        throw new Error(`Invalid 'to' value: ${to}`);
    }
  })();
}

/**
 * Calculate the result of the naive Kelly formula: f = k * (p - p_market) / (1 - p_market)
 *
 * @param marketProb The implied probability of the market
 * @param estimatedProb Your estimated probability of the outcome
 * @param deferenceFactor The deference factor k scales down the fraction to bet. A value of 0.5
 * is equivalent to saying "There is a 50% chance that I'm right, and a 50% chance the market is right"
 */
export function calculateNaiveKellyFraction({
  marketProb,
  estimatedProb,
  deferenceFactor,
}: NaiveKellyProps): { fraction: number; outcome: Outcome } {
  const outcome = estimatedProb > marketProb ? "YES" : "NO";
  // kellyFraction * ((p - p_market) / (1 - p_market))
  const fraction =
    deferenceFactor * (Math.abs(estimatedProb - marketProb) / (1 - marketProb));
  // clamp fraction between 0 and 1
  const clampedFraction = Math.min(Math.max(fraction, 0), 1);

  return {
    fraction: clampedFraction,
    outcome,
  };
}

/**
 * Multiply the naive Kelly fraction by the bankroll to get the amount to bet
 */
export function calculateNaiveKellyBet({
  bankroll,
  ...fractionOnlyProps
}: NaiveKellyProps & { bankroll: number }): BetRecommendation {
  const { fraction, outcome } = calculateNaiveKellyFraction(fractionOnlyProps);
  return {
    amount: bankroll * fraction,
    outcome,
  };
}

/**
 * Differentiate a function numerically
 */
async function D(
  f: AsyncUnivariateFunction,
  x: number,
  h = 1e-3
): Promise<number> {
  const fPlus = await f(x + h);
  const fMinus = await f(x - h);

  return (fPlus - fMinus) / (2 * h);
}

/**
 * Solve equation of the form f(x) = 0 using Newton's method
 */
export async function findRoot(
  f: AsyncUnivariateFunction,
  lowerBound: number,
  upperBound: number,
  iterations = 10,
  tolerance = 1e-6
): Promise<number> {
  let x = (lowerBound + upperBound) / 2;

  for (let i = 0; i < iterations; i++) {
    const fx = await f(x);
    const dfx = await D(f, x);

    let xNext = x - fx / dfx;

    // Check if xNext is within bounds
    if (xNext < lowerBound || xNext > upperBound) {
      // Option 2: Adjust xNext to be at the boundary
      xNext = xNext < lowerBound ? lowerBound : upperBound;
    }

    if (Math.abs(xNext - x) < tolerance) {
      // If the difference between x and xNext is less than the tolerance, we found a solution.
      console.log("Found root solution");
      return xNext;
    }

    x = xNext;
  }

  // If the solution is not found within the given number of iterations, return the last estimate.
  return x;
}

/**
 * Calculate the Kelly optimal bet, accounting for market liquidity. Assume a fixed bankroll
 * and a portfolio of only one bet
 */
export async function calculateFullKellyBet({
  estimatedProb,
  deferenceFactor,
  marketSlug,
  bankroll,
}: {
  estimatedProb: number;
  deferenceFactor: number;
  marketSlug: string;
  bankroll: number;
}): Promise<BetRecommendation & { shares: number; pAfter: number }> {
  const market = await fetchMarketCached({ slug: marketSlug });
  const startingMarketProb = (await market.getMarket())?.probability;
  if (!startingMarketProb) {
    logger.info("Could not get market prob");
    return { amount: 0, outcome: "YES", shares: 0, pAfter: 0 };
  }
  const { amount: naiveKellyAmount, outcome } = calculateNaiveKellyBet({
    marketProb: startingMarketProb,
    estimatedProb,
    deferenceFactor,
    bankroll,
  });

  const lowerBound = 0;
  const upperBound = naiveKellyAmount;

  const englishOdds = async (betEstimate: number) => {
    const { newShares } = await getBinaryCpmmBetInfoWrapper(
      outcome,
      betEstimate,
      marketSlug
    );
    return (newShares - betEstimate) / betEstimate;
  };
  const calcBetEstimate = async (betEstimate: number) => {
    const englishOddsEstimate = await englishOdds(betEstimate);
    const englishOddsDerivative = await D(englishOdds, betEstimate, 0.1);

    const pYes =
      estimatedProb * deferenceFactor +
      (1 - deferenceFactor) * startingMarketProb;
    const qYes = 1 - pYes;
    const pWin = outcome === "YES" ? pYes : qYes;
    const qWin = 1 - pWin;

    // Af^2 + Bf + C = 0 at optimum for _fraction_ of bankroll f
    const A = pWin * bankroll * englishOddsDerivative;
    const B = englishOddsEstimate - A;
    const C = -(pWin * englishOddsEstimate - qWin);

    // Using this intermediate root finding is _much_ more numerically stable than finding the
    // root of Af^2 + Bf + C = 0 directly for some reason
    const f = A === 0 ? -C / B : (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A);

    const newBetEstimate = f * bankroll;

    // This is the difference we want to be zero.
    return newBetEstimate - betEstimate;
  };

  const optimalBet = await findRoot(calcBetEstimate, lowerBound, upperBound);

  const { newShares: shares, probAfter: pAfter } =
    await getBinaryCpmmBetInfoWrapper(outcome, optimalBet, marketSlug);

  return {
    amount: optimalBet,
    outcome,
    shares,
    pAfter: pAfter ?? 0,
  };
}

/**
 * Calculate the Kelly optimal bet, accounting for market liquidity. Assume a fixed bankroll
 * and a portfolio of only one bet
 */
export async function calculateFullKellyBetWithPortfolio({
  estimatedProb,
  deferenceFactor,
  marketSlug,
  balance,
  portfolioValue,
}: {
  estimatedProb: number;
  deferenceFactor: number;
  marketSlug: string;
  balance: number;
  portfolioValue: number;
}): Promise<BetRecommendation & { shares: number; pAfter: number }> {
  // TODO use the actual user's portfolio
  // upper bound is calculateFullKellyBet with portfolioValue
  // lower bound is calculateFullKellyBet with balance

  // TODO set up a fake portfolio (of BetModels) and implement solver
  const illiquidEV = 1000;
  const relativeIlliquidEV = illiquidEV / balance;
  const bets: BetModel[] = [
    { probability: 0.5, payout: relativeIlliquidEV * (1 / 0.5) },
  ];
  const illiquidPmf = computePayoutDistribution(bets, "cartesian");

  // const illiquidEV = portfolioValue - balance;

  const market = await fetchMarketCached({ slug: marketSlug });
  const startingMarketProb = (await market.getMarket())?.probability;
  if (!startingMarketProb) {
    logger.info("Could not get market prob");
    return { amount: 0, outcome: "YES", shares: 0, pAfter: 0 };
  }
  const { amount: naiveKellyAmount, outcome } = calculateNaiveKellyBet({
    marketProb: startingMarketProb,
    estimatedProb,
    deferenceFactor,
    bankroll: balance,
  });

  const lowerBound = 0;
  const upperBound = naiveKellyAmount;

  const englishOdds = async (betEstimate: number) => {
    const { newShares } = await getBinaryCpmmBetInfoWrapper(
      outcome,
      betEstimate,
      marketSlug
    );
    return (newShares - betEstimate) / betEstimate;
  };

  /**
   * The derivative of the EV of the bet with respect to the bet amount, only considering the
   * user's balance, not other illiquid investments they have. This should give an optimal bet
   * _lower_ than the actual optimum
   */
  const dEVdBetBalanceOnly = async (betEstimate: number) => {
    const englishOddsEstimate = await englishOdds(betEstimate);
    const englishOddsDerivative = await D(englishOdds, betEstimate, 0.1);

    const pYes =
      estimatedProb * deferenceFactor +
      (1 - deferenceFactor) * startingMarketProb;
    const qYes = 1 - pYes;
    const pWin = outcome === "YES" ? pYes : qYes;
    const qWin = 1 - pWin;

    // Af^2 + Bf + C = 0 at optimum for _fraction_ of bankroll f
    const A = pWin * balance * englishOddsDerivative;
    const B = englishOddsEstimate - A;
    const C = -(pWin * englishOddsEstimate - qWin);

    // Using this intermediate root finding is _much_ more numerically stable than finding the
    // root of Af^2 + Bf + C = 0 directly for some reason
    const f = A === 0 ? -C / B : (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A);

    const newBetEstimate = f * balance;

    // This is the difference we want to be zero.
    return newBetEstimate - betEstimate;
  };
  /**
   * The derivative of the EV of the bet with respect to the bet amount, considering the
   * user's balance and treating the illiquid investments as if they are a lump of cash
   * equal to their current expected value ("cashed out" is a bit of misnomer here because
   * selling the shares would actually change the market price and so you couldn't recover the
   * full EV). This should give an optimal bet _higher_ than the actual optimum, because we are optimising
   * log wealth, which means scenarios where the illiquid investments don't pay out much hurt the EV more
   * than the other way around.
   */
  const dEVdBetIlliquidCashedOut = async (betEstimate: number) => {
    const englishOddsEstimate = await englishOdds(betEstimate);
    const englishOddsDerivative = await D(englishOdds, betEstimate, 0.1);

    const pYes =
      estimatedProb * deferenceFactor +
      (1 - deferenceFactor) * startingMarketProb;
    const qYes = 1 - pYes;
    const pWin = outcome === "YES" ? pYes : qYes;
    const qWin = 1 - pWin;

    const f = betEstimate / balance;
    const I = relativeIlliquidEV;

    const A = (pWin * englishOddsEstimate) / (1 + I + f * englishOddsEstimate);
    const B = -qWin / (1 + I - f);
    const C =
      (pWin * f * englishOddsDerivative * balance) /
      (1 + I + f * englishOddsEstimate);

    return A + B + C;
  };
  /**
   * The derivative of the EV of the bet with respect to the bet amount, considering the
   * user's balance and modelling the range of outcomes of the illiquid investments. This should
   * give the true optimal bet, and be between the other two values
   */
  const dEVdBet = async (betEstimate: number) => {
    const englishOddsEstimate = await englishOdds(betEstimate);
    const englishOddsDerivative = await D(englishOdds, betEstimate, 0.1);

    const pYes =
      estimatedProb * deferenceFactor +
      (1 - deferenceFactor) * startingMarketProb;
    const qYes = 1 - pYes;
    const pWin = outcome === "YES" ? pYes : qYes;
    const qWin = 1 - pWin;

    const f = betEstimate / balance;

    const integrand = (I: number) => {
      const A =
        (pWin * englishOddsEstimate) / (1 + I + f * englishOddsEstimate);
      const B = -qWin / (1 + I - f);
      const C =
        (pWin * f * englishOddsDerivative * balance) /
        (1 + I + f * englishOddsEstimate);

      return A + B + C;
    };
    const integral = integrateOverPmf(integrand, illiquidPmf);

    return integral;
  };

  const optimalBetInitial = await findRoot(
    dEVdBetBalanceOnly,
    lowerBound,
    upperBound
  );
  const optimalBet = await findRoot(
    dEVdBet,
    optimalBetInitial * 0.5,
    optimalBetInitial * 2
  );
  const optimalBetHigh = await findRoot(
    dEVdBetIlliquidCashedOut,
    optimalBetInitial * 0.5,
    optimalBetInitial * 2
  );

  console.log({ optimalBetInitial, optimalBet, optimalBetHigh });

  // get the shares and pAfter
  const { newShares: shares, probAfter: pAfter } =
    await getBinaryCpmmBetInfoWrapper(outcome, optimalBet, marketSlug);

  return {
    amount: optimalBet,
    outcome,
    shares,
    pAfter: pAfter ?? 0,
  };
}
