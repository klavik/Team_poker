window.TEAM_CALCULATOR_INTEGRATION = {
  // Адрес интерфейса Team_calculator.
  // Приложения размещены соседними каталогами, поэтому
  // относительный URL не зависит от домена публикации.
  teamCalculatorBaseUrl: "../team_calculator/",
  // Team_poker → Team_calculator:
  // browser создаёт job в Firestore Team_poker,
  // metadata_connector переносит данные в Team_calculator.
  syncTransport: "firestore",
  syncCollection: "team_calculator_sync",

  // Team_calculator → Team_poker:
  // metadata_connector зеркалит статусы в Firestore Team_poker.
  statusTransport: "firestore",
  statusCollection: "delivery_status"
};
