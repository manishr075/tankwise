import unittest

from water_balance import round2, simulate_water_balance, validate_inputs

BASE = {
    "buildingName": "Test hostel",
    "currentStockLiters": 8000,
    "tankCapacityLiters": 10000,
    "dailyConsumptionLiters": 1800,
    "roofAreaM2": 120,
    "collectionEfficiency": 0.8,
    "leadTimeDays": 2,
    "safetyStockLiters": 1800,
    "forecastMm": [0, 0, 20, 10, 0, 0, 0],
}


def run(**overrides):
    return simulate_water_balance({**BASE, **overrides})


class WaterBalanceTests(unittest.TestCase):
    def test_one_mm_on_one_square_metre_is_one_litre(self):
        day = run(currentStockLiters=100, tankCapacityLiters=1000, dailyConsumptionLiters=50, roofAreaM2=1,
                  collectionEfficiency=1, leadTimeDays=0, safetyStockLiters=0, forecastMm=[1])["forecastTimeline"][0]
        self.assertEqual(day["potentialHarvestLiters"], 1)
        self.assertEqual(day["stockAfterLiters"], 51)

    def test_rain_is_applied_after_demand(self):
        day = run(currentStockLiters=50, tankCapacityLiters=1000, dailyConsumptionLiters=100, roofAreaM2=100,
                  collectionEfficiency=1, leadTimeDays=0, safetyStockLiters=0, forecastMm=[1])["forecastTimeline"][0]
        self.assertEqual(day["shortageLiters"], 50)
        self.assertEqual(day["stockAfterLiters"], 100)

    def test_overflow_is_calculated_separately(self):
        day = run(currentStockLiters=900, tankCapacityLiters=1000, dailyConsumptionLiters=100, roofAreaM2=100,
                  collectionEfficiency=1, leadTimeDays=0, safetyStockLiters=0, forecastMm=[10])["forecastTimeline"][0]
        self.assertEqual(day["stockAfterLiters"], 1000)
        self.assertEqual(day["overflowLiters"], 800)

    def test_known_answer(self):
        r = run()
        self.assertEqual(r["forecastDeadlineDays"], 3)
        self.assertEqual(r["noRainDeadlineDays"], 1)
        self.assertEqual(r["forecastArrivalDay"], 5)
        self.assertEqual(r["targetStockLiters"], 5400)
        self.assertEqual(r["estimatedTopUpLiters"], 3520)
        self.assertEqual(r["noRainEstimatedTopUpLiters"], 2800)
        self.assertEqual(r["forecastFirstBelowSafetyDay"], 6)
        self.assertEqual(r["noRainFirstBelowSafetyDay"], 4)

    def test_lead_time_zero(self):
        r = run(leadTimeDays=0, forecastMm=[0] * 7)
        self.assertEqual(r["forecastDeadlineDays"], 3)
        self.assertEqual(r["forecastStockAtArrivalLiters"], 2600)

    def test_below_reserve_is_critical_even_with_zero_lead_time(self):
        r = run(currentStockLiters=1000, leadTimeDays=0, forecastMm=[50, 0, 0])
        self.assertIsNone(r["forecastDeadlineDays"])
        self.assertTrue(r["belowSafetyNow"])
        self.assertEqual(r["urgency"], "critical")

    def test_safety_above_stock(self):
        r = run(currentStockLiters=3000, safetyStockLiters=4000)
        self.assertIsNone(r["noRainDeadlineDays"])
        self.assertIn("already below the safety buffer", r["recommendation"])

    def test_empty_forecast_equals_no_rain(self):
        r = run(forecastMm=[])
        self.assertEqual(r["forecastTimeline"], r["noRainTimeline"])

    def test_rain_extends_window_but_no_rain_stays_visible(self):
        r = run()
        self.assertGreater(r["forecastDeadlineDays"], r["noRainDeadlineDays"])

    def test_extreme_rain_caps_and_window_cap(self):
        r = run(forecastMm=[500] * 14)
        self.assertTrue(all(d["stockAfterLiters"] <= 10000 for d in r["forecastTimeline"]))
        self.assertGreater(r["forecastOverflowLiters"], 0)
        self.assertEqual(r["forecastDeadlineDays"], 14)

    def test_demand_exceeding_stock(self):
        r = run(currentStockLiters=900, safetyStockLiters=0, forecastMm=[])
        self.assertEqual(r["forecastTimeline"][0]["shortageLiters"], 900)
        self.assertTrue(all(d["stockAfterLiters"] >= 0 for d in r["forecastTimeline"]))
        self.assertIsNone(r["forecastDeadlineDays"])

    def test_days_8_to_14_extend_the_window_and_are_not_dropped(self):
        late = [0] * 9 + [20] + [0] * 4  # 20 mm on day 10 = 1,920 L
        tank = {"currentStockLiters": 8000, "dailyConsumptionLiters": 500, "leadTimeDays": 0, "safetyStockLiters": 1800}
        full = run(**tank, forecastMm=late)
        cut_at_7 = run(**tank, forecastMm=late[:7])
        self.assertEqual(len(full["forecastTimeline"]), 14)
        self.assertEqual(full["forecastTimeline"][9]["potentialHarvestLiters"], 1920)
        self.assertEqual(cut_at_7["noRainDeadlineDays"], 12)
        self.assertEqual(full["forecastDeadlineDays"], 14)
        self.assertEqual(cut_at_7["forecastDeadlineDays"], 12)
        self.assertEqual(full["noRainDeadlineDays"], 12)

    def test_round_half_up(self):
        self.assertEqual(round2(0.125), 0.13)
        self.assertEqual(round2(1.004), 1)

    def test_rejects_invalid_inputs(self):
        cases = [
            ({"currentStockLiters": 11000}, "cannot exceed tank capacity"),
            ({"forecastMm": [0, -1]}, "zero or greater"),
            ({"collectionEfficiency": 1.4}, "between 0 and 1"),
            ({"leadTimeDays": 1.5}, "whole number from 0 to 14"),
            ({"leadTimeDays": 15}, "whole number from 0 to 14"),
            ({"safetyStockLiters": 20000}, "Safety stock cannot exceed"),
            ({"dailyConsumptionLiters": ""}, "must be a number"),
            ({"roofAreaM2": True}, "must be a number"),
            ({"forecastMm": [0] * 15}, "no more than 14"),
            ({"forecastMm": "0,0"}, "must be an array"),
        ]
        for overrides, message in cases:
            with self.subTest(overrides=overrides):
                with self.assertRaisesRegex(ValueError, message):
                    validate_inputs({**BASE, **overrides})


if __name__ == "__main__":
    unittest.main()
